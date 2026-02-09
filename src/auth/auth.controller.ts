import { Body, Controller, Get, Inject, Post, Request, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { JwtAuthGuard } from './jwt.guard.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private auth: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Request() req: { user: { sub: string; email: string; role: string } }) {
    return {
      id: req.user.sub,
      email: req.user.email,
      role: req.user.role,
    };
  }
}
