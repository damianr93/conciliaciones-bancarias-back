import { IsString, MinLength } from 'class-validator';

export class AddExcludedConceptDto {
  @IsString()
  @MinLength(1)
  concept!: string;
}
