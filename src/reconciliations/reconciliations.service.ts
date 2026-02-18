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
import { matchOneToOne } from './utils/match.js';

@Injectable()
export class ReconciliationsService {
  constructor(private prisma: PrismaService) {}

  async createRun(dto: CreateRunDto, userId: string) {
    const windowDays = dto.windowDays ?? 0;
    const cutDate = dto.cutDate ? parseDate(dto.cutDate) : null;

    let categories = await this.prisma.expenseCategory.findMany({
      include: { rules: true },
    });
    const enabledIds = Array.isArray(dto.enabledCategoryIds) && dto.enabledCategoryIds.length > 0
      ? new Set(dto.enabledCategoryIds)
      : null;
    if (enabledIds) {
      categories = categories.filter((c) => enabledIds.has(c.id));
    }

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
        enabledCategoryIds: (dto.enabledCategoryIds ?? []) as Prisma.JsonArray,
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

    const allMatches = matches;

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
        issues: { include: { createdBy: true, comments: { include: { author: true } } } },
      },
    });
    if (!run) return null;
    const activeExtractIds = new Set(
      run.extractLines.filter((l) => !l.excluded).map((l) => l.id),
    );
    const extractAmountById = new Map(
      run.extractLines.map((l) => [l.id, l.amount]),
    );
    const systemAmountById = new Map(run.systemLines.map((l) => [l.id, l.amount]));
    const amountTolerance = 0.01;
    const matchesWithSameAmount = run.matches.filter((m) => {
      if (!activeExtractIds.has(m.extractLineId)) return false;
      const extAmount = extractAmountById.get(m.extractLineId);
      const sysAmount = systemAmountById.get(m.systemLineId);
      if (extAmount == null || sysAmount == null) return false;
      return Math.abs(extAmount - sysAmount) <= amountTolerance;
    });
    const hiddenMatches = run.matches.filter((m) => {
      if (!activeExtractIds.has(m.extractLineId)) return false;
      const extAmount = extractAmountById.get(m.extractLineId);
      const sysAmount = systemAmountById.get(m.systemLineId);
      if (extAmount == null || sysAmount == null) return true;
      return Math.abs(extAmount - sysAmount) > amountTolerance;
    });
    const hiddenExtractIds = new Set(hiddenMatches.map((m) => m.extractLineId));
    const hiddenSystemIds = new Set(hiddenMatches.map((m) => m.systemLineId));
    const baseUnmatchedExtract = run.unmatchedExtract.filter((ue) =>
      activeExtractIds.has(ue.extractLineId),
    );
    const extraUnmatchedExtract = [...hiddenExtractIds]
      .filter((id) => activeExtractIds.has(id))
      .map((extractLineId) => ({
        id: randomUUID(),
        runId: run.id,
        extractLineId,
      }));
    const extraUnmatchedSystem = [...hiddenSystemIds].map((systemLineId) => {
      const line = run.systemLines.find((l) => l.id === systemLineId);
      const dateToCompare = line?.dueDate ?? line?.issueDate ?? null;
      let status: UnmatchedSystemStatus = UnmatchedSystemStatus.DEFERRED;
      if (run.cutDate && dateToCompare && dateToCompare <= run.cutDate) {
        status = UnmatchedSystemStatus.OVERDUE;
      }
      return {
        id: randomUUID(),
        runId: run.id,
        systemLineId,
        status,
      };
    });
    return {
      ...run,
      excludeConcepts: (run.excludeConcepts as string[]) ?? [],
      extractLines: run.extractLines.filter((l) => !l.excluded),
      matches: matchesWithSameAmount,
      unmatchedExtract: [...baseUnmatchedExtract, ...extraUnmatchedExtract],
      unmatchedSystem: [...run.unmatchedSystem, ...extraUnmatchedSystem],
    };
  }

  async updateRun(
    runId: string,
    userId: string,
    data: { status?: RunStatus; bankName?: string | null; enabledCategoryIds?: string[] },
  ) {
    await this.assertCanEdit(runId, userId);
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
        ...(data.enabledCategoryIds !== undefined && {
          enabledCategoryIds: data.enabledCategoryIds as Prisma.JsonArray,
        }),
      },
    });
  }

  async deleteRun(runId: string, userId: string) {
    await this.assertCanEdit(runId, userId);
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
    const normalized = (concept ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) throw new BadRequestException('Concepto requerido');
    return this.addExcludedConcepts(runId, userId, [concept.trim()]);
  }

  async addExcludedConcepts(runId: string, userId: string, concepts: string[]) {
    await this.assertCanEdit(runId, userId);
    await this.assertRunOpen(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { excludeConcepts: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    const norm = (s: string | null | undefined) =>
      (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const current = (run.excludeConcepts as string[]) ?? [];
    const nextConcepts = [...current];
    const normalizedNew = new Set<string>();
    for (const concept of concepts) {
      const n = norm(concept);
      if (!n) continue;
      if (current.some((c) => norm(c) === n)) continue;
      if (normalizedNew.has(n)) continue;
      normalizedNew.add(n);
      nextConcepts.push(concept.trim());
    }
    if (nextConcepts.length === current.length) return this.getRun(runId);

    const linesToExclude = await this.prisma.extractLine.findMany({
      where: { runId, excluded: false, concept: { not: null } },
    });
    const toExclude = linesToExclude.filter((l) =>
      Array.from(normalizedNew).some((n) => norm(l.concept) === n),
    );

    const extractLineIds = toExclude.map((l) => l.id);
    await this.applyExcludedLines(runId, nextConcepts as Prisma.JsonArray, extractLineIds);
    return this.getRun(runId);
  }

  async addExcludedByCategory(runId: string, userId: string, categoryId: string) {
    await this.assertCanEdit(runId, userId);
    await this.assertRunOpen(runId);
    const category = await this.prisma.expenseCategory.findUnique({
      where: { id: categoryId },
      include: { rules: true },
    });
    if (!category) throw new NotFoundException('Categoría no encontrada');
    const rules = category.rules ?? [];
    if (rules.length === 0) {
      throw new BadRequestException(
        'La categoría no tiene reglas. Agregá conceptos en Categorías para que coincidan con las líneas del extracto.',
      );
    }
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { excludeConcepts: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    const norm = (s: string | null | undefined) =>
      (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const current = (run.excludeConcepts as string[]) ?? [];
    const categoryNorm = norm(category.name);
    if (current.some((c) => norm(c) === categoryNorm)) {
      return this.getRun(runId);
    }
    const nextConcepts = [...current, category.name];

    const candidates = await this.prisma.extractLine.findMany({
      where: { runId, excluded: false, concept: { not: null } },
    });
    const toExclude = candidates.filter((line) =>
      this.conceptMatchesCategory(line.concept, category),
    );
    if (toExclude.length === 0) return this.getRun(runId);

    const extractLineIds = toExclude.map((l) => l.id);
    await this.applyExcludedLines(runId, nextConcepts as Prisma.JsonArray, extractLineIds);
    return this.getRun(runId);
  }

  async removeExcludedConcept(runId: string, userId: string, concept: string) {
    await this.assertCanEdit(runId, userId);
    await this.assertRunOpen(runId);
    const norm = (s: string | null | undefined) =>
      (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { excludeConcepts: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    const current = (run.excludeConcepts as string[]) ?? [];
    const nextConcepts = current.filter((c) => norm(c) !== norm(concept));
    if (nextConcepts.length === current.length) return this.getRun(runId);

    const category = await this.prisma.expenseCategory.findFirst({
      where: { name: { equals: concept, mode: 'insensitive' } },
      include: { rules: true },
    });
    const excludedLines = await this.prisma.extractLine.findMany({
      where: { runId, excluded: true },
    });
    const toUnexclude =
      category && (category.rules ?? []).length > 0
        ? excludedLines.filter((line) =>
            this.conceptMatchesCategory(line.concept, category),
          )
        : excludedLines.filter((line) => norm(line.concept) === norm(concept));

    await this.prisma.reconciliationRun.update({
      where: { id: runId },
      data: { excludeConcepts: nextConcepts as Prisma.JsonArray },
    });
    if (toUnexclude.length > 0) {
      await this.prisma.extractLine.updateMany({
        where: { id: { in: toUnexclude.map((l) => l.id) } },
        data: { excluded: false },
      });
      await this.recomputeMatches(runId);
    }
    return this.getRun(runId);
  }

  private conceptMatchesCategory(
    concept: string | null,
    category: { rules?: Array<{ pattern: string; isRegex: boolean; caseSensitive: boolean }> | null },
  ): boolean {
    if (!concept) return false;
    const rules = category.rules ?? [];
    const normSpace = (s: string) =>
      s
        .replace(/\u00A0/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
    for (const rule of rules) {
      const pattern = rule.pattern.trim();
      if (!pattern) continue;
      if (rule.isRegex) {
        try {
          const re = new RegExp(pattern, rule.caseSensitive ? '' : 'i');
          if (re.test(concept)) return true;
        } catch {
          const haystack = normSpace(rule.caseSensitive ? concept : concept.toLowerCase());
          const needle = normSpace(rule.caseSensitive ? pattern : pattern.toLowerCase());
          if (haystack.includes(needle)) return true;
        }
      } else {
        const haystack = normSpace(rule.caseSensitive ? concept : concept.toLowerCase());
        const needle = normSpace(rule.caseSensitive ? pattern : pattern.toLowerCase());
        if (haystack.includes(needle)) return true;
      }
    }
    return false;
  }

  private async applyExcludedLines(
    runId: string,
    nextConcepts: Prisma.JsonArray,
    extractLineIds: string[],
  ) {
    await this.prisma.reconciliationRun.update({
      where: { id: runId },
      data: { excludeConcepts: nextConcepts },
    });
    const cut = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { cutDate: true },
    });
    const cutDate = cut?.cutDate ?? null;
    for (const extractLineId of extractLineIds) {
      await this.prisma.$transaction(async (tx) => {
        const matches = await tx.match.findMany({
          where: { extractLineId },
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
            const dt = sys?.dueDate ?? sys?.issueDate ?? null;
            const status =
              cutDate && dt && dt <= cutDate
                ? UnmatchedSystemStatus.OVERDUE
                : UnmatchedSystemStatus.DEFERRED;
            await tx.unmatchedSystem.create({
              data: { runId, systemLineId: m.systemLineId, status },
            });
          }
        }
        await tx.unmatchedExtract.deleteMany({
          where: { extractLineId },
        });
        await tx.extractLine.update({
          where: { id: extractLineId },
          data: { excluded: true },
        });
      });
    }
  }

  async updateSystemData(runId: string, userId: string, dto: UpdateSystemDto) {
    await this.assertRunExists(runId);
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

    const TX_TIMEOUT_MS = 60_000;
    await this.prisma.$transaction(
      async (tx) => {
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
          const unmatchedSystemRows = toCreate.map((line) => {
            const dt = line.dueDate ?? line.issueDate ?? null;
            const dtDate = dt instanceof Date ? dt : (dt ? new Date(dt as unknown as string) : null);
            const status =
              cutDate && dtDate && dtDate <= cutDate ? UnmatchedSystemStatus.OVERDUE : UnmatchedSystemStatus.DEFERRED;
            return { runId, systemLineId: line.id, status };
          });
          await tx.unmatchedSystem.createMany({ data: unmatchedSystemRows });
        }
      },
      { timeout: TX_TIMEOUT_MS },
    );

    await this.recomputeMatches(runId);
    return this.getRun(runId);
  }

  private async recomputeMatches(runId: string) {
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { windowDays: true, cutDate: true },
    });
    if (!run) return;
    const windowDays = run.windowDays ?? 0;
    const cutDate = run.cutDate;

    const extractLines = await this.prisma.extractLine.findMany({
      where: { runId, excluded: false },
    });
    const systemLines = await this.prisma.systemLine.findMany({
      where: { runId },
    });

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

    const unmatchedExtract = extractLines
      .filter((line) => !usedExtract.has(line.id))
      .map((line) => ({
        id: randomUUID(),
        runId,
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
          runId,
          systemLineId: line.id,
          status,
        };
      });

    const matchRows = matches.map((match) => ({
      id: randomUUID(),
      runId,
      extractLineId: match.extractId,
      systemLineId: match.systemId,
      deltaDays: match.deltaDays,
    }));

    await this.prisma.$transaction([
      this.prisma.match.deleteMany({ where: { runId } }),
      this.prisma.unmatchedExtract.deleteMany({ where: { runId } }),
      this.prisma.unmatchedSystem.deleteMany({ where: { runId } }),
      this.prisma.match.createMany({ data: matchRows }),
      this.prisma.unmatchedExtract.createMany({ data: unmatchedExtract }),
      this.prisma.unmatchedSystem.createMany({ data: unmatchedSystem }),
    ]);
  }

  listRuns() {
    return this.prisma.reconciliationRun.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertRunExists(runId: string) {
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
  }

  async assertCanEdit(runId: string, userId: string) {
    await this.assertRunExists(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      include: { members: true },
    });
    if (!run) return;
    const isOwner = run.createdById === userId;
    const isAdmin = run.members.some((m) => m.userId === userId && m.role === RunMemberRole.EDITOR);
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Solo el propietario o un usuario con permiso de admin pueden editar');
    }
  }

  private async assertOwner(runId: string, userId: string) {
    await this.assertRunExists(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { createdById: true },
    });
    if (!run || run.createdById !== userId) {
      throw new ForbiddenException('Solo el propietario puede gestionar permisos');
    }
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
    await this.assertOwner(runId, userId);
    await this.assertRunOpen(runId);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.prisma.runMember.upsert({
      where: { runId_userId: { runId, userId: user.id } },
      update: { role },
      create: { runId, userId: user.id, role },
    });
  }

  async removeMember(runId: string, ownerUserId: string, targetUserId: string) {
    await this.assertOwner(runId, ownerUserId);
    await this.prisma.runMember.deleteMany({
      where: { runId, userId: targetUserId },
    });
    return { removed: true };
  }

  async addMessage(runId: string, userId: string, body: string) {
    await this.assertCanEdit(runId, userId);
    await this.assertRunOpen(runId);
    return this.prisma.message.create({
      data: { runId, authorId: userId, body },
      include: { author: true },
    });
  }

  async exportRun(runId: string, userId: string) {
    const run = await this.getRun(runId);
    if (!run) throw new NotFoundException('Run no encontrado');
    await this.assertCanEdit(runId, userId);

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
    const normSpace = (s: string) => s.trim().replace(/\s+/g, ' ');
    for (const category of categories) {
      for (const rule of category.rules) {
        const pattern = rule.pattern.trim();
        if (!pattern) continue;
        if (rule.isRegex) {
          try {
            const re = new RegExp(pattern, rule.caseSensitive ? '' : 'i');
            if (re.test(concept)) return category.id;
          } catch {
            const haystack = normSpace(rule.caseSensitive ? concept : concept.toLowerCase());
            const needle = normSpace(rule.caseSensitive ? pattern : pattern.toLowerCase());
            if (haystack.includes(needle)) return category.id;
          }
        } else {
          const haystack = normSpace(rule.caseSensitive ? concept : concept.toLowerCase());
          const needle = normSpace(rule.caseSensitive ? pattern : pattern.toLowerCase());
          if (haystack.includes(needle)) return category.id;
        }
      }
    }
    return null;
  }

  async createPending(runId: string, userId: string, dto: CreatePendingDto) {
    await this.assertCanEdit(runId, userId);
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
    await this.assertCanEdit(runId, userId);
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
    await this.assertCanEdit(runId, userId);
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
    await this.assertCanEdit(runId, userId);
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
    await this.assertRunExists(runId);
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

    const mailerHost = process.env.MAILER_HOST || process.env.SMTP_HOST;
    const mailerEmail = process.env.MAILER_EMAIL || process.env.SMTP_USER;
    const mailerSecret = process.env.MAILER_SECRET_KEY || process.env.SMTP_PASS;
    const mailerPort = process.env.MAILER_PORT || process.env.SMTP_PORT || (mailerHost === 'smtp.gmail.com' ? '587' : '587');
    const from = process.env.SMTP_FROM || mailerEmail;

    if (!mailerHost || !mailerEmail || !mailerSecret) {
      throw new BadRequestException(
        'Correo no configurado. Configurar MAILER_HOST, MAILER_EMAIL y MAILER_SECRET_KEY (o SMTP_*) en variables de entorno',
      );
    }

    const port = parseInt(String(mailerPort), 10);
    const transporter = nodemailer.createTransport({
      host: mailerHost,
      port,
      secure: port === 465,
      auth: { user: mailerEmail, pass: mailerSecret },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });

    const areaEmails: Record<string, string> = {
      'Dirección': process.env.EMAIL_DIRECCION || '',
      'Tesorería': process.env.EMAIL_TESORERIA || '',
    };

    const areasSinEmail = dto.areas.filter((a) => !areaEmails[a]?.trim());
    if (areasSinEmail.length > 0) {
      throw new BadRequestException(
        `No hay email configurado para: ${areasSinEmail.join(', ')}. En el servidor configurar EMAIL_DIRECCION y/o EMAIL_TESORERIA.`,
      );
    }

    const results = [];
    for (const area of dto.areas) {
      const areaEmail = (areaEmails[area] || '').trim();
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
          from,
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

  async createIssue(
    runId: string,
    userId: string,
    data: { title: string; body?: string },
  ) {
    await this.assertRunExists(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    return this.prisma.issue.create({
      data: {
        runId,
        title: data.title,
        body: data.body ?? null,
        createdById: userId,
      },
      include: { createdBy: true, comments: { include: { author: true } } },
    });
  }

  async updateIssue(
    runId: string,
    issueId: string,
    userId: string,
    data: { title?: string; body?: string },
  ) {
    await this.assertRunExists(runId);
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
      select: { createdById: true },
    });
    if (!run) throw new NotFoundException('Run no encontrado');
    if (run.createdById !== userId) {
      throw new ForbiddenException('Solo la propietaria de la conciliación puede editar el issue');
    }
    return this.prisma.issue.update({
      where: { id: issueId, runId },
      data: {
        ...(data.title != null && { title: data.title }),
        ...(data.body !== undefined && { body: data.body }),
      },
      include: { createdBy: true, comments: { include: { author: true } } },
    });
  }

  async addIssueComment(issueId: string, userId: string, body: string) {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { runId: true },
    });
    if (!issue) throw new NotFoundException('Issue no encontrado');
    await this.assertRunExists(issue.runId);
    return this.prisma.issueComment.create({
      data: { issueId, authorId: userId, body },
      include: { author: true },
    });
  }
}
