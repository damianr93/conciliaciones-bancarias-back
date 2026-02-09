import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum AreaType {
  DIRECCION = 'Dirección',
  PAGOS = 'Pagos',
  ADMINISTRACION = 'Administración',
  LOGISTICA = 'Logística',
}

export class CreatePendingDto {
  @IsEnum(AreaType)
  area!: AreaType;

  @IsString()
  systemLineId!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ResolvePendingDto {
  @IsString()
  note!: string;
}
