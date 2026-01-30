import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateRuleDto {
  @IsString()
  categoryId!: string;

  @IsString()
  pattern!: string;

  @IsOptional()
  @IsBoolean()
  isRegex?: boolean;

  @IsOptional()
  @IsBoolean()
  caseSensitive?: boolean;
}
