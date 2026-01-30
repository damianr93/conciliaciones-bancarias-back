# Conciliaciones Backend (NestJS + Prisma)

## Requisitos
- Node 20+
- Postgres local (o Railway)

## Configuración
- Copia `.env.example` a `.env` y ajusta valores.

## Instalación
```bash
npm install
```

## Migraciones y seed
```bash
npx prisma migrate dev --name init
npm run seed
```

## Dev
```bash
npm run start:dev
```

## Endpoints base
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/reconciliations`
- `GET /api/reconciliations`
- `GET /api/reconciliations/:id`
- `GET /api/reconciliations/:id/export`
- `POST /api/reconciliations/:id/share`
- `POST /api/reconciliations/:id/messages`
- `GET /api/expenses/categories`
- `POST /api/expenses/categories`
- `POST /api/expenses/rules`

## Railway
- Build command: `npm run prisma:generate && npm run build`
- Start command: `npm run prisma:migrate && npm run start`
