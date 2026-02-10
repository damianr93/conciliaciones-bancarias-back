import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RunMemberRole, UnmatchedSystemStatus, PendingStatus, RunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import ExcelJS from 'exceljs';
import xlsx from 'node-xlsx';
import nodemailer from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateRunDto } from './dto/create-run.dto.js';
import { UpdateSystemDto } from './dto/update-system.dto.js';
import { CreatePendingDto, ResolvePendingDto } from './dto/create-pending.dto.js';
import { NotifyDto } from './dto/notify.dto.js';
import {
  extractAmount,
  normalizeText,
  parseDate,
  toAmountKey,
} from './utils/normalize.js';
import { matchOneToOne, matchManyToOneByComment } from './utils/match.js';

@Injectable()
export class ReconciliationsService {
  constructor(private prisma: PrismaService) {}

  async createRun(dto: CreateRunDto, userId: string) {
    const windowDays = dto.windowDays ?? 0;
    const cutDate = dto.cutDate ? parseDate(dto.cutDate) : null;

    const categories = await this.prisma.expenseCategory.findMany({
      include: { rules: true },
    });

    const extractLines: Array<Prisma.ExtractLineCreateManyInput & { id: string }> = [];
    for (const row of dto.extract.rows) {
      const concept = normalizeText(
        dto.extract.mapping.conceptCol
          ? String(row[dto.extract.mapping.conceptCol] ?? '')
          : undefined,
      );
      if (
        dto.extract.excludeConcepts &&
        concept &&
        dto.extract.excludeConcepts.includes(concept)
      ) {
        continue;
      }
      const amount = extractAmount(
        row,
        dto.extract.mapping.amountMode,
        dto.extract.mapping.amountCol,
        dto.extract.mapping.debeCol,
        dto.extract.mapping.haberCol,
      );
      if (amount === null) continue;
      const date = parseDate(row[dto.extract.mapping.dateCol]);
      const amountKey = toAmountKey(amount);
      const categoryId = this.resolveCategory(concept, categories);
      extractLines.push({
        id: randomUUID(),
        date,
        concept,
        amount,
        amountKey,
        raw: row as Prisma.JsonObject,
        categoryId,
        runId: '',
      });
    }

    const systemLines: Array<Prisma.SystemLineCreateManyInput & { id: string }> = [];
    for (const row of dto.system.rows) {
      const amount = extractAmount(
        row,
        dto.system.mapping.amountMode,
        dto.system.mapping.amountCol,
        dto.system.mapping.debeCol,
        dto.system.mapping.haberCol,
      );
      if (amount === null) continue;
      const issueDate = dto.system.mapping.issueDateCol
        ? parseDate(row[dto.system.mapping.issueDateCol])
        : null;
      const dueDate = dto.system.mapping.dueDateCol
        ? parseDate(row[dto.system.mapping.dueDateCol])
        : null;
      const description = dto.system.mapping.descriptionCol
        ? String(row[dto.system.mapping.descriptionCol] || '')
        : null;
      const amountKey = toAmountKey(amount);
      systemLines.push({
        id: randomUUID(),
        rowIndex: systemLines.length,
        issueDate,
        dueDate,
        amount,
        amountKey,
        description,
        raw: row as Prisma.JsonObject,
        runId: '',
      });
    }

    const run = await this.prisma.reconciliationRun.create({
      data: {
        title: dto.title,
        bankName: dto.bankName,
        accountRef: dto.accountRef,
        windowDays,
        cutDate: cutDate ?? undefined,
        excludeConcepts: (dto.extract.excludeConcepts ?? []) as Prisma.JsonArray,
        createdById: userId,
      },
    });

    for (const line of extractLines) {
      line.runId = run.id;
    }
    for (const line of systemLines) {
      line.runId = run.id;
    }

    await this.prisma.$transaction([
      this.prisma.extractLine.createMany({ data: extractLines }),
      this.prisma.systemLine.createMany({ data: systemLines }),
      this.prisma.runMember.create({
        data: {
          runId: run.id,
          userId,
          role: RunMemberRole.OWNER,
        },
      }),
    ]);

    const systemForMatch = systemLines.map((line) => ({
      id: line.id,
      issueDate: line.issueDate ? new Date(line.issueDate) : null,
      dueDate: line.dueDate ? new Date(line.dueDate) : null,
      amountKey: line.amountKey as bigint,
      amount: line.amount,
      description: line.description ?? null,
    }));
    const extractForMatch = extractLines.map((line) => ({
      id: line.id,
      date: line.date ? new Date(line.date) : null,
      amountKey: line.amountKey as bigint,
    }));

    const { matches, usedExtract, usedSystem } = matchOneToOne(
      systemForMatch,
      extractForMatch,
      windowDays,
    );

    const commentMatches = matchManyToOneByComment(
      systemForMatch,
      extractForMatch,
      usedExtract,
      usedSystem,
    );

    const allMatches = [...matches, ...commentMatches];

    const unmatchedExtract = extractLines
      .filter((line) => !usedExtract.has(line.id))
      .map((line) => ({
        id: randomUUID(),
        runId: run.id,
        extractLineId: line.id,
      }));

    const unmatchedSystem = systemLines
      .filter((line) => !usedSystem.has(line.id))
      .map((line) => {
        const dateToCompare = line.dueDate ?? line.issueDate ?? null;
        let status: UnmatchedSystemStatus = UnmatchedSystemStatus.DEFERRED;
        if (cutDate && dateToCompare && dateToCompare <= cutDate) {
          status = UnmatchedSystemStatus.OVERDUE;
        }
        return {
          id: randomUUID(),
          runId: run.id,
          systemLineId: line.id,
          status,
        };
      });

    const matchRows = allMatches.map((match) => ({
      id: randomUUID(),
      runId: run.id,
      extractLineId: match.extractId,
      systemLineId: match.systemId,
      deltaDays: match.deltaDays,
    }));

    await this.prisma.$transaction([
      this.prisma.match.createMany({ data: matchRows }),
      this.prisma.unmatchedExtract.createMany({ data: unmatchedExtract }),
      this.prisma.unmatchedSystem.createMany({ data: unmatchedSystem }),
    ]);

    const summary = {
      runId: run.id,
      matched: matchRows.length,
      onlyExtract: unmatchedExtract.length,
      systemOverdue: unmatchedSystem.filter((u) => u.status === 'OVERDUE').length,
      systemDeferred: unmatchedSystem.filter((u) => u.status === 'DEFERRED').length,
    };

    return summary;
  }

  async getRun(runId: string) {
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      include: {
        extractLines: { include: { category: true } },
        systemLines: true,
        matches: true,
        unmatchedExtract: true,
        unmatchedSystem: true,
        members: { include: { user: true } },
        messages: { include: { author: true } },
        pendingItems: { include: { systemLine: true } },
      },
    });
    if (!run) return null;
    const activeExtractIds = new Set(
      run.extractLines.filter((l) => !l.excluded).map((l) => l.id),
    );
    return {
      ...run,
      excludeConcepts: (run.excludeConcepts as string[]) ?? [],
      extractLines: run.extractLines.filter((l) => !l.excluded),
      matches: run.matches.filter((m) => activeExtractIds.has(m.extractLineId)),
      unmatchedExtract: run.unmatchedExtract.filter((ue) =>
        activeExtractIds.has(ue.extractLineId),
      ),
    };
  }

  async updateRun(runId: string, userId: string, data: { status?: RunStatus; bankName?: string | null }) {
    await this.assertAccess(runId, userId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { status: true, createdById: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    if (run.status === RunStatus.CLOSED) {
      if (data.status === RunStatus.OPEN && run.createdById === userId) {
        return this.prisma.reconciliationRun.update({
          where: { id: runId },
          data: { status: RunStatus.OPEN },
        });
      }
      throw new ForbiddenException('Conciliación cerrada: solo el creador puede reabrirla');
    }
    return this.prisma.reconciliationRun.update({
      where: { id: runId },
      data: {
        ...(data.status != null && { status: data.status }),
        ...(data.bankName !== undefined && { bankName: data.bankName ?? null }),
      },
    });
  }

  async deleteRun(runId: string, userId: string) {
    await this.assertAccess(runId, userId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    if (run.status !== RunStatus.OPEN) {
      throw new ForbiddenException('Solo se puede borrar una conciliación abierta');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.match.deleteMany({ where: { runId } });
      await tx.unmatchedExtract.deleteMany({ where: { runId } });
      await tx.unmatchedSystem.deleteMany({ where: { runId } });
      await tx.pendingItem.deleteMany({ where: { runId } });
      await tx.message.deleteMany({ where: { runId } });
      await tx.runMember.deleteMany({ where: { runId } });
      await tx.extractLine.deleteMany({ where: { runId } });
      await tx.systemLine.deleteMany({ where: { runId } });
      await tx.cheque.deleteMany({ where: { runId } });
      await tx.reconciliationRun.delete({ where: { id: runId } });
    });
    return { deleted: true };
  }

  async addExcludedConcept(runId: string, userId: string, concept: string) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { excludeConcepts: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    const norm = (s: string | null | undefined) =>
      (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const normalized = norm(concept);
    if (!normalized) throw new BadRequestException('Concepto requerido');

    const current = (run.excludeConcepts as string[]) ?? [];
    if (current.some((c) => norm(c) === normalized)) {
      return this.getRun(runId);
    }
    const nextConcepts = [...current, concept.trim()];

    const linesToExclude = await this.prisma.extractLine.findMany({
      where: {
        runId,
        excluded: false,
        concept: { not: null },
      },
    });
    const toExclude = linesToExclude.filter(
      (l) => norm(l.concept) === normalized,
    );
    const extractIds = new Set(toExclude.map((l) => l.id));

    await this.prisma.$transaction(async (tx) => {
      await tx.reconciliationRun.update({
        where: { id: runId },
        data: { excludeConcepts: nextConcepts as Prisma.JsonArray },
      });
      for (const line of toExclude) {
        const matches = await tx.match.findMany({
          where: { extractLineId: line.id },
        });
        for (const m of matches) {
          await tx.match.delete({ where: { id: m.id } });
          const existing = await tx.unmatchedSystem.findUnique({
            where: { systemLineId: m.systemLineId },
          });
          if (!existing) {
            const sys = await tx.systemLine.findUnique({
              where: { id: m.systemLineId },
              select: { dueDate: true, issueDate: true },
            });
            const cut = await tx.reconciliationRun.findUnique({
              where: { id: runId },
              select: { cutDate: true },
            });
            const dt = sys?.dueDate ?? sys?.issueDate ?? null;
            const status =
              cut?.cutDate && dt && dt <= cut.cutDate
                ? UnmatchedSystemStatus.OVERDUE
                : UnmatchedSystemStatus.DEFERRED;
            await tx.unmatchedSystem.create({
              data: { runId, systemLineId: m.systemLineId, status },
            });
          }
        }
        await tx.unmatchedExtract.deleteMany({
          where: { extractLineId: line.id },
        });
        await tx.extractLine.update({
          where: { id: line.id },
          data: { excluded: true },
        });
      }
    });

    return this.getRun(runId);
  }

  async updateSystemData(runId: string, userId: string, dto: UpdateSystemDto) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    const runWithCut = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { cutDate: true },
    });
    const cutDate = runWithCut?.cutDate ?? null;

    const existing = await this.prisma.systemLine.findMany({
      where: { runId },
      orderBy: { rowIndex: 'asc' },
    });
    const byRowIndex = new Map<number, (typeof existing)[0]>();
    for (const line of existing) {
      if (line.rowIndex !== null) byRowIndex.set(line.rowIndex, line);
    }

    const toUpdate: Array<{ id: string; amount: number; amountKey: bigint; issueDate: Date | null; dueDate: Date | null; description: string | null; raw: Prisma.JsonObject }> = [];
    const toCreate: Array<Prisma.SystemLineCreateManyInput & { id: string }> = [];

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      const amount = extractAmount(
        row,
        dto.mapping.amountMode,
        dto.mapping.amountCol,
        dto.mapping.debeCol,
        dto.mapping.haberCol,
      );
      if (amount === null) continue;
      const issueDate = dto.mapping.issueDateCol
        ? parseDate(row[dto.mapping.issueDateCol])
        : null;
      const dueDate = dto.mapping.dueDateCol
        ? parseDate(row[dto.mapping.dueDateCol])
        : null;
      const description = dto.mapping.descriptionCol
        ? String(row[dto.mapping.descriptionCol] || '')
        : null;
      const amountKey = toAmountKey(amount);
      const raw = row as Prisma.JsonObject;

      const existingLine = byRowIndex.get(i);
      if (existingLine) {
        toUpdate.push({
          id: existingLine.id,
          amount,
          amountKey,
          issueDate,
          dueDate,
          description,
          raw,
        });
      } else {
        toCreate.push({
          id: randomUUID(),
          runId,
          rowIndex: i,
          issueDate,
          dueDate,
          amount,
          amountKey,
          description,
          raw,
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const u of toUpdate) {
        await tx.systemLine.update({
          where: { id: u.id },
          data: {
            amount: u.amount,
            amountKey: u.amountKey,
            issueDate: u.issueDate,
            dueDate: u.dueDate,
            description: u.description,
            raw: u.raw,
          },
        });
      }
      if (toCreate.length > 0) {
        await tx.systemLine.createMany({ data: toCreate });
        for (const line of toCreate) {
          const dt = line.dueDate ?? line.issueDate ?? null;
          const dtDate = dt instanceof Date ? dt : (dt ? new Date(dt as unknown as string) : null);
          const status =
            cutDate && dtDate && dtDate <= cutDate ? UnmatchedSystemStatus.OVERDUE : UnmatchedSystemStatus.DEFERRED;
          await tx.unmatchedSystem.create({
            data: {
              runId,
              systemLineId: line.id,
              status,
            },
          });
        }
      }
    });

    return this.getRun(runId);
  }

  listRuns(userId: string) {
    return this.prisma.reconciliationRun.findMany({
      where: {
        OR: [
          { createdById: userId },
          { members: { some: { userId } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async assertAccess(runId: string, userId: string) {
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      include: { members: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    const isOwner = run.createdById === userId;
    const isMember = run.members.some((member) => member.userId === userId);
    if (!isOwner && !isMember) {
      throw new ForbiddenException('Sin acceso');
    }
    return run;
  }

  private async assertRunOpen(runId: string) {
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    if (run.status === RunStatus.CLOSED) {
      throw new ForbiddenException('Conciliación cerrada: no se puede editar');
    }
  }

  async shareRun(runId: string, userId: string, email: string, role: RunMemberRole) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    if (run.createdById !== userId) {
      throw new ForbiddenException('Solo el owner puede compartir');
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.prisma.runMember.upsert({
      where: { runId_userId: { runId, userId: user.id } },
      update: { role },
      create: { runId, userId: user.id, role },
    });
  }

  async addMessage(runId: string, userId: string, body: string) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    return this.prisma.message.create({
      data: { runId, authorId: userId, body },
      include: { author: true },
    });
  }

  async exportRun(runId: string, userId: string) {
    const run = await this.getRun(runId);
    if (!run) throw new NotFoundException('Run no encontrado');
    await this.assertAccess(runId, userId);

    const extractById = new Map(run.extractLines.map((line) => [line.id, line]));
    const systemById = new Map(run.systemLines.map((line) => [line.id, line]));

    const workbook = new ExcelJS.Workbook();
    const matchesSheet = workbook.addWorksheet('Correctos');
    matchesSheet.columns = [
      { header: 'Fecha Extracto', key: 'extDate', width: 16 },
      { header: 'Concepto', key: 'concept', width: 40 },
      { header: 'Importe Extracto', key: 'extAmount', width: 18 },
      { header: 'Fecha Emision', key: 'issueDate', width: 16 },
      { header: 'Fecha Vencimiento', key: 'dueDate', width: 18 },
      { header: 'Importe Sistema', key: 'sysAmount', width: 18 },
      { header: 'Delta Dias', key: 'delta', width: 12 },
      { header: 'Categoria', key: 'category', width: 28 },
    ];

    for (const match of run.matches) {
      const ext = extractById.get(match.extractLineId);
      const sys = systemById.get(match.systemLineId);
      if (!ext || !sys) continue;
      matchesSheet.addRow({
        extDate: ext.date,
        concept: ext.concept,
        extAmount: ext.amount,
        issueDate: sys.issueDate,
        dueDate: sys.dueDate,
        sysAmount: sys.amount,
        delta: match.deltaDays,
        category: ext.category?.name || '',
      });
    }

    const extractSheet = workbook.addWorksheet('Solo_Extracto');
    extractSheet.columns = [
      { header: 'Fecha', key: 'date', width: 16 },
      { header: 'Concepto', key: 'concept', width: 40 },
      { header: 'Importe', key: 'amount', width: 18 },
      { header: 'Categoria', key: 'category', width: 28 },
    ];
    for (const row of run.unmatchedExtract) {
      const ext = extractById.get(row.extractLineId);
      if (!ext) continue;
      extractSheet.addRow({
        date: ext.date,
        concept: ext.concept,
        amount: ext.amount,
        category: ext.category?.name || '',
      });
    }

    const overdueSheet = workbook.addWorksheet('Sistema_Vencidos');
    overdueSheet.columns = [
      { header: 'Fecha Emision', key: 'issueDate', width: 16 },
      { header: 'Fecha Vencimiento', key: 'dueDate', width: 18 },
      { header: 'Importe', key: 'amount', width: 18 },
    ];

    const deferredSheet = workbook.addWorksheet('Sistema_Diferidos');
    deferredSheet.columns = [
      { header: 'Fecha Emision', key: 'issueDate', width: 16 },
      { header: 'Fecha Vencimiento', key: 'dueDate', width: 18 },
      { header: 'Importe', key: 'amount', width: 18 },
    ];

    for (const row of run.unmatchedSystem) {
      const sys = systemById.get(row.systemLineId);
      if (!sys) continue;
      const target = row.status === 'OVERDUE' ? overdueSheet : deferredSheet;
      target.addRow({
        issueDate: sys.issueDate,
        dueDate: sys.dueDate,
        amount: sys.amount,
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
  }

  async parseFile(
    file: Express.Multer.File,
    sheetName?: string,
    headerRow?: number,
  ) {
    if (!file) {
      throw new NotFoundException('Archivo requerido');
    }
    const name = file.originalname.toLowerCase();
    try {
      if (name.endsWith('.csv')) {
        const workbook = new ExcelJS.Workbook();
        const stream = Readable.from(file.buffer);
        await workbook.csv.read(stream);
        const sheets = workbook.worksheets.map((sheet) => sheet.name);
        const targetName = sheetName && sheets.includes(sheetName) ? sheetName : sheets[0];
        const sheet = workbook.getWorksheet(targetName || '');
        if (!sheet) return { sheets, rows: [] };
        const headerIndex = Math.max(1, headerRow ?? 1);
        const header: string[] = [];
        const colCount = sheet.actualColumnCount || sheet.columnCount || 0;
        for (let col = 1; col <= colCount; col += 1) {
          const cell = sheet.getRow(headerIndex).getCell(col).value;
          const text = cell ? String(this.cellValue(cell)).trim() : '';
          header.push(text || `Col_${col}`);
        }
        const rows: Record<string, unknown>[] = [];
        for (let rowIndex = headerIndex + 1; rowIndex <= sheet.actualRowCount; rowIndex += 1) {
          const row = sheet.getRow(rowIndex);
          const obj: Record<string, unknown> = {};
          let hasValue = false;
          for (let col = 1; col <= colCount; col += 1) {
            const value = this.cellValue(row.getCell(col).value);
            if (value !== null && value !== undefined && value !== '') {
              hasValue = true;
            }
            obj[header[col - 1]] = value;
          }
          if (hasValue) rows.push(obj);
        }
        return { sheets, rows };
      }

      const parsed = xlsx.parse(file.buffer, { cellDates: true });
      const sheets = parsed.map((sheet) => sheet.name);
      if (sheets.length === 0) return { sheets: [], rows: [] };
      const targetName = sheetName && sheets.includes(sheetName) ? sheetName : sheets[0];
      const target = parsed.find((sheet) => sheet.name === targetName);
      if (!target) return { sheets, rows: [] };
      const data = target.data as unknown[][];
      const headerIndex = Math.max(1, headerRow ?? 1) - 1;
      const headerRowValues = data[headerIndex] || [];
      const header = headerRowValues.map((cell, idx) => {
        const text = cell ? String(cell).trim() : '';
        return text || `Col_${idx + 1}`;
      });
      const rows: Record<string, unknown>[] = [];
      for (let i = headerIndex + 1; i < data.length; i += 1) {
        const line = data[i] || [];
        const obj: Record<string, unknown> = {};
        let hasValue = false;
        for (let col = 0; col < header.length; col += 1) {
          const value = line[col] ?? null;
          if (value !== null && value !== undefined && value !== '') {
            hasValue = true;
          }
          obj[header[col]] = value;
        }
        if (hasValue) rows.push(obj);
      }
      return { sheets, rows };
    } catch (error) {
      throw new BadRequestException('No se pudo leer el archivo. Verificá el formato.');
    }
  }

  private resolveCategory(
    concept: string | null,
    categories: Array<{ id: string; rules: Array<{ pattern: string; isRegex: boolean; caseSensitive: boolean }> }>,
  ) {
    if (!concept) return null;
    for (const category of categories) {
      for (const rule of category.rules) {
        const haystack = rule.caseSensitive ? concept : concept.toLowerCase();
        const needle = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
        if (rule.isRegex) {
          const re = new RegExp(needle, rule.caseSensitive ? '' : 'i');
          if (re.test(concept)) return category.id;
        } else if (haystack.includes(needle)) {
          return category.id;
        }
      }
    }
    return null;
  }

  async createPending(runId: string, userId: string, dto: CreatePendingDto) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    return this.prisma.pendingItem.create({
      data: {
        runId,
        area: dto.area,
        systemLineId: dto.systemLineId,
        note: dto.note,
      },
    });
  }

  async resolvePending(runId: string, userId: string, pendingId: string, dto: ResolvePendingDto) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    return this.prisma.pendingItem.update({
      where: { id: pendingId },
      data: {
        status: PendingStatus.RESOLVED,
        resolvedAt: new Date(),
        note: dto.note,
      },
    });
  }

  async updatePendingStatus(runId: string, userId: string, pendingId: string, status: PendingStatus) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    return this.prisma.pendingItem.update({
      where: { id: pendingId },
      data: { status },
    });
  }

  async setMatch(
    runId: string,
    userId: string,
    systemLineId: string,
    extractLineIds: string[],
  ) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      include: {
        systemLines: { where: { id: systemLineId } },
        extractLines: { where: { id: { in: extractLineIds } } },
      },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    const sys = run.systemLines[0];
    if (!sys) throw new NotFoundException('Línea de sistema no encontrada');
    if (extractLineIds.length !== run.extractLines.length) {
      throw new BadRequestException('Una o más líneas de extracto no pertenecen a este run');
    }
    const sumExtract = run.extractLines.reduce((s, e) => s + e.amount, 0);
    const diff = Math.abs(sumExtract - sys.amount);
    if (diff > 0.01) {
      throw new BadRequestException(
        `La suma de los importes del extracto (${sumExtract.toFixed(2)}) debe coincidir con el importe del sistema (${sys.amount.toFixed(2)})`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.match.deleteMany({ where: { runId, systemLineId } });
      await tx.unmatchedSystem.deleteMany({ where: { runId, systemLineId } });
      for (const extractLineId of extractLineIds) {
        await tx.match.create({
          data: {
            runId,
            systemLineId,
            extractLineId,
            deltaDays: 0,
          },
        });
        await tx.unmatchedExtract.deleteMany({
          where: { runId, extractLineId },
        });
      }
    });

    return this.getRun(runId);
  }

  async notifyPending(runId: string, userId: string, dto: NotifyDto) {
    await this.assertAccess(runId, userId);
    await this.assertRunOpen(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      include: {
        pendingItems: {
          where: {
            area: { in: dto.areas },
            status: { not: PendingStatus.RESOLVED },
          },
          include: { systemLine: true },
        },
      },
    });

    if (!run) throw new NotFoundException('Run no encontrado');
    if (run.pendingItems.length === 0) {
      throw new BadRequestException('No hay pendientes para las áreas seleccionadas');
    }

    const smtpHost = process.env.SMTP_HOST || 'smtp.donweb.com';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM || smtpUser;

    if (!smtpUser || !smtpPass) {
      throw new BadRequestException('SMTP no configurado. Configurar SMTP_USER y SMTP_PASS en variables de entorno');
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const areaEmails: Record<string, string> = {
      'Dirección': process.env.EMAIL_DIRECCION || '',
      'Pagos': process.env.EMAIL_PAGOS || '',
      'Administración': process.env.EMAIL_ADMINISTRACION || '',
      'Logística': process.env.EMAIL_LOGISTICA || '',
    };

    const results = [];
    for (const area of dto.areas) {
      const areaEmail = areaEmails[area];
      if (!areaEmail) continue;

      const areaPending = run.pendingItems.filter((p) => p.area === area);
      
      const rows = areaPending.map((p) => {
        const sys = p.systemLine;
        return `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd;">${sys?.issueDate ? new Date(sys.issueDate).toLocaleDateString() : '-'}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${sys?.dueDate ? new Date(sys.dueDate).toLocaleDateString() : '-'}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">$${sys?.amount?.toFixed(2) || '0.00'}</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${p.note || '-'}</td>
          </tr>
        `;
      }).join('');

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
          <h2 style="color: #333;">Conciliación Bancaria - Movimientos Pendientes</h2>
          <p>Hola equipo de <strong>${area}</strong>,</p>
          <p>Hemos realizado la conciliación encontrando ${areaPending.length} movimiento(s) que requieren atención de tu área:</p>
          ${dto.customMessage ? `<p style="background: #f5f5f5; padding: 12px; border-left: 4px solid #3b82f6;"><em>${dto.customMessage}</em></p>` : ''}
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <thead>
              <tr style="background: #f5f5f5;">
                <th style="padding: 12px; border: 1px solid #ddd; text-align: left;">Fecha Emisión</th>
                <th style="padding: 12px; border: 1px solid #ddd; text-align: left;">Fecha Vencimiento</th>
                <th style="padding: 12px; border: 1px solid #ddd; text-align: left;">Importe</th>
                <th style="padding: 12px; border: 1px solid #ddd; text-align: left;">Nota</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
          <p style="color: #666; font-size: 14px; margin-top: 30px;">
            Por favor revisar y gestionar estos movimientos.<br/>
            Conciliación: ${run.title || run.id}<br/>
            Fecha: ${new Date(run.createdAt).toLocaleDateString()}
          </p>
        </div>
      `;

      try {
        await transporter.sendMail({
          from: smtpFrom,
          to: areaEmail,
          subject: `Conciliación Bancaria - Movimientos Pendientes [${area}]`,
          html,
        });
        results.push({ area, email: areaEmail, sent: true });
      } catch (error: any) {
        results.push({ area, email: areaEmail, sent: false, error: error.message });
      }
    }

    return results;
  }

  private cellValue(value: ExcelJS.CellValue | null | undefined): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') {
      if ('result' in value) return (value as any).result;
      if (value instanceof Date) return value;
    }
    return value as any;
  }
}
