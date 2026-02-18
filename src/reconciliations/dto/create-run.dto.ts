import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ExtractMappingDto, SystemMappingDto } from './mapping.dto.js';

export class DatasetDto {
  @IsArray()
  rows!: Record<string, unknown>[];

  @ValidateNested()
  @Type(() => ExtractMappingDto)
  mapping!: ExtractMappingDto;

  @IsOptional()
  @IsArray()
  excludeConcepts?: string[];
}

export class SystemDatasetDto {
  @IsArray()
  rows!: Record<string, unknown>[];

  @ValidateNested()
  @Type(() => SystemMappingDto)
  mapping!: SystemMappingDto;
}

export class CreateRunDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  accountRef?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  windowDays?: number;

  @IsOptional()
  @IsString()
  cutDate?: string;

  @ValidateNested()
  @Type(() => DatasetDto)
  extract!: DatasetDto;

  @ValidateNested()
  @Type(() => SystemDatasetDto)
  system!: SystemDatasetDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledCategoryIds?: string[];
}
