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
- `PATCH /api/reconciliations/:id` (estado: OPEN/CLOSED, bankName)
- `PATCH /api/reconciliations/:id/system` (actualizar Excel sistema preservando estado)
- `PATCH /api/reconciliations/:id/exclude-concept` (agregar concepto excluido en workspace)
- `POST /api/reconciliations/:id/match` (asignar/cambiar match: systemLineId + extractLineIds[])
- `GET /api/reconciliations/:id/export`
- `POST /api/reconciliations/:id/share`
- `POST /api/reconciliations/:id/messages`
- `GET /api/expenses/categories`
- `POST /api/expenses/categories`
- `POST /api/expenses/rules`

## Funcionalidad
- Estado de conciliación: abierta/cerrada.
- Banco seleccionable al crear (Nación, Galicia, Santander, etc.).
- Actualización del Excel de sistema sin perder matches ni pendientes (por rowIndex).
- Match por comentario: varias filas sistema con el mismo comentario pueden sumar y matchear una fila extracto.
- Match N:N: una línea sistema puede matchear con varias líneas extracto (suma = importe).
- Conceptos excluidos: se guardan al crear; en el espacio de trabajo se pueden agregar más (por si se pasaron al crear).

## Railway
- Build command: `npm run prisma:generate && npm run build`
- Start command: `npm run prisma:migrate && npm run start`
