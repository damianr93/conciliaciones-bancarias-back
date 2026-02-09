import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const defaultCategories = [
  'Comisiones bancarias gravadas en IVA',
  'IVA',
  'Gastos y comisiones NO gravadas',
  'Impuesto a los débitos',
  'Impuesto a los créditos',
  'Impuesto IIBB Tucuman',
  'SIRCREB',
  'Percepciones de IVA',
];

const defaultRules: Record<string, string[]> = {
  'Comisiones bancarias gravadas en IVA': ['comision', 'comisión'],
  IVA: ['iva'],
  'Gastos y comisiones NO gravadas': ['gasto', 'comision no gravada', 'comisión no gravada'],
  'Impuesto a los débitos': ['debito', 'débito'],
  'Impuesto a los créditos': ['credito', 'crédito'],
  'Impuesto IIBB Tucuman': ['iibb', 'iibb tucuman'],
  SIRCREB: ['sircreb'],
  'Percepciones de IVA': ['percepcion', 'percepción'],
};

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@local.test';
  const adminPass = process.env.SEED_ADMIN_PASSWORD || 'Admin123!';

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    const hash = await bcrypt.hash(adminPass, 10);
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: hash,
        role: Role.ADMIN,
      },
    });
  }

  for (const name of defaultCategories) {
    const category = await prisma.expenseCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });

    const rules = defaultRules[name] || [];
    for (const pattern of rules) {
      const exists = await prisma.expenseRule.findFirst({
        where: { categoryId: category.id, pattern },
      });
      if (!exists) {
        await prisma.expenseRule.create({
          data: { categoryId: category.id, pattern, isRegex: false, caseSensitive: false },
        });
      }
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
