import { IsString, MinLength } from 'class-validator';

export class RemoveExcludedConceptDto {
  @IsString()
  @MinLength(1)
  concept!: string;
}
