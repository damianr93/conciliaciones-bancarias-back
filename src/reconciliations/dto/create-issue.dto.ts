import { IsString, MinLength, IsOptional } from 'class-validator';

export class CreateIssueDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @IsOptional()
  body?: string;
}

export class UpdateIssueDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  body?: string;
}

export class CreateIssueCommentDto {
  @IsString()
  @MinLength(1)
  body!: string;
}
