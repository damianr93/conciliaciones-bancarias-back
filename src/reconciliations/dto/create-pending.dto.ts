import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum AreaType {
  DIRECCION = 'Dirección',
  TESORERIA = 'Tesorería',
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
