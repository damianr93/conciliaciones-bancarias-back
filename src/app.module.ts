import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { UsersModule } from './users/users.module.js';
import { ReconciliationsModule } from './reconciliations/reconciliations.module.js';
import { HealthModule } from './common/health.module.js';
import { ExpensesModule } from './expenses/expenses.module.js';
import { loggerConfig } from './common/logger.config.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 100,
    }]),
    WinstonModule.forRoot(loggerConfig),
    PrismaModule,
    AuthModule,
    UsersModule,
    ReconciliationsModule,
    HealthModule,
    ExpensesModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
