import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService) {}

  listCategories() {
    return this.prisma.expenseCategory.findMany({
      include: { rules: true },
      orderBy: { name: 'asc' },
    });
  }

  createCategory(name: string) {
    return this.prisma.expenseCategory.create({ data: { name } });
  }

  deleteCategory(id: string) {
    return this.prisma.expenseCategory.delete({ where: { id } });
  }

  createRule(data: {
    categoryId: string;
    pattern: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
  }) {
    return this.prisma.expenseRule.create({
      data: {
        categoryId: data.categoryId,
        pattern: data.pattern,
        isRegex: data.isRegex ?? false,
        caseSensitive: data.caseSensitive ?? false,
      },
    });
  }

  deleteRule(id: string) {
    return this.prisma.expenseRule.delete({ where: { id } });
  }
}
