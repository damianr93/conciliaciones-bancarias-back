import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { AreaType } from './create-pending.dto.js';

export class NotifyDto {
  @IsArray()
  @IsEnum(AreaType, { each: true })
  areas!: AreaType[];

  @IsOptional()
  @IsString()
  customMessage?: string;
}
