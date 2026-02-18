import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class ExcludeManyDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  concepts!: string[];
}
