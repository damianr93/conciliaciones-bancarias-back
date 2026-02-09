import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class SetMatchDto {
  @IsString()
  systemLineId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  extractLineIds!: string[];
}
