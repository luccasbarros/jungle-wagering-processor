import { Injectable, type CanActivate } from '@nestjs/common';

// ponytail: no-op extension point (spec section 2); the OAuth2 client-credentials design is documented in ARCHITECTURE.md.
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
