import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SystemMappingDto } from './mapping.dto.js';

export class UpdateSystemDto {
  @IsArray()
  rows!: Record<string, unknown>[];

  @ValidateNested()
  @Type(() => SystemMappingDto)
  mapping!: SystemMappingDto;
}
