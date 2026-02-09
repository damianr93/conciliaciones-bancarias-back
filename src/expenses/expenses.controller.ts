import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { CreateRuleDto } from './dto/create-rule.dto.js';
import { ExpensesService } from './expenses.service.js';

@Controller('expenses')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExpensesController {
  constructor(private service: ExpensesService) {}

  @Get('categories')
  listCategories() {
    return this.service.listCategories();
  }

  @Roles('ADMIN')
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.service.createCategory(dto.name);
  }

  @Roles('ADMIN')
  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.service.deleteCategory(id);
  }

  @Roles('ADMIN')
  @Post('rules')
  createRule(@Body() dto: CreateRuleDto) {
    return this.service.createRule(dto);
  }

  @Roles('ADMIN')
  @Delete('rules/:id')
  deleteRule(@Param('id') id: string) {
    return this.service.deleteRule(id);
  }
}
