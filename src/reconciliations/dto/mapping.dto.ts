import { IsIn, IsOptional, IsString } from 'class-validator';

export class ExtractMappingDto {
  @IsString()
  dateCol!: string;

  @IsOptional()
  @IsString()
  conceptCol?: string;

  @IsIn(['single', 'debe-haber'])
  amountMode!: 'single' | 'debe-haber';

  @IsOptional()
  @IsString()
  amountCol?: string;

  @IsOptional()
  @IsString()
  debeCol?: string;

  @IsOptional()
  @IsString()
  haberCol?: string;
}

export class SystemMappingDto {
  @IsOptional()
  @IsString()
  issueDateCol?: string;

  @IsOptional()
  @IsString()
  dueDateCol?: string;

  @IsIn(['single', 'debe-haber'])
  amountMode!: 'single' | 'debe-haber';

  @IsOptional()
  @IsString()
  amountCol?: string;

  @IsOptional()
  @IsString()
  debeCol?: string;

  @IsOptional()
  @IsString()
  haberCol?: string;

  @IsOptional()
  @IsString()
  descriptionCol?: string;
}
