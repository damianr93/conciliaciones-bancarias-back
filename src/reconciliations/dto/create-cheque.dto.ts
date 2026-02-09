import { IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateChequeDto {
  @IsOptional()
  @IsString()
  number?: string;

  @IsOptional()
  @IsString()
  issueDate?: string;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsNumber()
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
