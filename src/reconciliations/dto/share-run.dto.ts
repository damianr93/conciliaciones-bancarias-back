import { IsEmail, IsIn } from 'class-validator';

export class ShareRunDto {
  @IsEmail()
  email!: string;

  @IsIn(['OWNER', 'EDITOR', 'VIEWER'])
  role!: 'OWNER' | 'EDITOR' | 'VIEWER';
}
