import { Module } from '@nestjs/common';
import { ReconciliationsController } from './reconciliations.controller.js';
import { ReconciliationsService } from './reconciliations.service.js';

@Module({
  controllers: [ReconciliationsController],
  providers: [ReconciliationsService],
})
export class ReconciliationsModule {}
