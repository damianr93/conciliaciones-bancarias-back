import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RunMemberRole, UnmatchedSystemStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import ExcelJS from 'exceljs';
import xlsx from 'node-xlsx';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateRunDto } from './dto/create-run.dto.js';
import {
  extractAmount,
  normalizeText,
  parseDate,
  toAmountKey,
} from './utils/normalize.js';
import { matchOneToOne } from './utils/match.js';

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
      const amountKey = toAmountKey(amount);
      systemLines.push({
        id: randomUUID(),
        issueDate,
        dueDate,
        amount,
        amountKey,
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

    const { matches, usedExtract, usedSystem } = matchOneToOne(
      systemLines.map((line) => ({
        id: line.id,
        issueDate: line.issueDate ? new Date(line.issueDate) : null,
        dueDate: line.dueDate ? new Date(line.dueDate) : null,
        amountKey: line.amountKey as bigint,
      })),
      extractLines.map((line) => ({
        id: line.id,
        date: line.date ? new Date(line.date) : null,
        amountKey: line.amountKey as bigint,
      })),
      windowDays,
    );

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

    const matchRows = matches.map((match) => ({
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
      },
    });
    if (!run) return null;
    return run;
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

  async shareRun(runId: string, userId: string, email: string, role: RunMemberRole) {
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

  private cellValue(value: ExcelJS.CellValue | null | undefined): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') {
      if ('result' in value) return (value as any).result;
      if (value instanceof Date) return value;
    }
    return value as any;
  }
}
