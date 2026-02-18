import { IsString, MinLength } from 'class-validator';

export class ExcludeByCategoryDto {
  @IsString()
  @MinLength(1)
  categoryId!: string;
}
