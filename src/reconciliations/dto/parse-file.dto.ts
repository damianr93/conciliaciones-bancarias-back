import { IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class ParseFileDto {
  @IsOptional()
  @IsString()
  sheetName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  headerRow?: number;
}
