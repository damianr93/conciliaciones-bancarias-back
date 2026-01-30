import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { UsersService } from './users.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { JwtAuthGuard } from '../auth/jwt.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { RolesGuard } from '../common/guards/roles.guard.js';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private users: UsersService) {}

  @Roles('ADMIN')
  @Post()
  async create(@Body() dto: CreateUserDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.users.create({
      email: dto.email,
      passwordHash,
      role: dto.role as Role,
    });
    return { id: user.id, email: user.email, role: user.role };
  }

  @Roles('ADMIN')
  @Get()
  list() {
    return this.users.list();
  }
}
