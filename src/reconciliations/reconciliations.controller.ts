import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard.js';
import { ReconciliationsService } from './reconciliations.service.js';
import { CreateRunDto } from './dto/create-run.dto.js';
import { ShareRunDto } from './dto/share-run.dto.js';
import { CreateMessageDto } from './dto/message.dto.js';
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
}
