import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PendingStatus, RunStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt.guard.js';
import { ReconciliationsService } from './reconciliations.service.js';
import { CreateRunDto } from './dto/create-run.dto.js';
import { UpdateSystemDto } from './dto/update-system.dto.js';
import { ShareRunDto } from './dto/share-run.dto.js';
import { CreateMessageDto } from './dto/message.dto.js';
import { CreatePendingDto, ResolvePendingDto } from './dto/create-pending.dto.js';
import { NotifyDto } from './dto/notify.dto.js';
import { SetMatchDto } from './dto/set-match.dto.js';
import { AddExcludedConceptDto } from './dto/add-excluded-concept.dto.js';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ParseFileDto } from './dto/parse-file.dto.js';

@Controller('reconciliations')
@UseGuards(JwtAuthGuard)
export class ReconciliationsController {
  constructor(private service: ReconciliationsService) {}

  @Post()
  create(
    @Body() dto: CreateRunDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.createRun(dto, req.user.sub);
  }

  @Get()
  list(@Request() req: { user: { sub: string } }) {
    return this.service.listRuns(req.user.sub);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Request() req: { user: { sub: string } }) {
    await this.service.assertAccess(id, req.user.sub);
    return this.service.getRun(id);
  }

  @Patch(':id/system')
  async updateSystem(
    @Param('id') id: string,
    @Body() dto: UpdateSystemDto,
    @Request() req: { user: { sub: string } },
  ) {
    await this.service.assertAccess(id, req.user.sub);
    return this.service.updateSystemData(id, req.user.sub, dto);
  }

  @Patch(':id/exclude-concept')
  addExcludedConcept(
    @Param('id') id: string,
    @Body() dto: AddExcludedConceptDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.addExcludedConcept(id, req.user.sub, dto.concept);
  }

  @Patch(':id')
  async updateRun(
    @Param('id') id: string,
    @Body() body: { status?: RunStatus; bankName?: string },
    @Request() req: { user: { sub: string } },
  ) {
    await this.service.assertAccess(id, req.user.sub);
    return this.service.updateRun(id, req.user.sub, body);
  }

  @Delete(':id')
  async deleteRun(@Param('id') id: string, @Request() req: { user: { sub: string } }) {
    await this.service.deleteRun(id, req.user.sub);
    return { deleted: true };
  }

  @Post(':id/share')
  share(
    @Param('id') id: string,
    @Body() dto: ShareRunDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.shareRun(id, req.user.sub, dto.email, dto.role);
  }

  @Post(':id/messages')
  addMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.addMessage(id, req.user.sub, dto.body);
  }

  @Post('parse')
  @UseInterceptors(FileInterceptor('file'))
  parseFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ParseFileDto,
  ) {
    return this.service.parseFile(file, dto.sheetName, dto.headerRow);
  }

  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @Request() req: { user: { sub: string } },
    @Res() res: Response,
  ) {
    const buffer = await this.service.exportRun(id, req.user.sub);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=conciliacion_${id}.xlsx`);
    res.send(buffer);
  }

  @Post(':id/pending')
  createPending(
    @Param('id') id: string,
    @Body() dto: CreatePendingDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.createPending(id, req.user.sub, dto);
  }

  @Patch(':id/pending/:pendingId/resolve')
  resolvePending(
    @Param('id') id: string,
    @Param('pendingId') pendingId: string,
    @Body() dto: ResolvePendingDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.resolvePending(id, req.user.sub, pendingId, dto);
  }

  @Patch(':id/pending/:pendingId/status')
  updatePendingStatus(
    @Param('id') id: string,
    @Param('pendingId') pendingId: string,
    @Body() body: { status: PendingStatus },
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.updatePendingStatus(id, req.user.sub, pendingId, body.status);
  }

  @Post(':id/match')
  setMatch(
    @Param('id') id: string,
    @Body() dto: SetMatchDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.setMatch(id, req.user.sub, dto.systemLineId, dto.extractLineIds);
  }

  @Post(':id/notify')
  notifyPending(
    @Param('id') id: string,
    @Body() dto: NotifyDto,
    @Request() req: { user: { sub: string } },
  ) {
    return this.service.notifyPending(id, req.user.sub, dto);
  }
}
