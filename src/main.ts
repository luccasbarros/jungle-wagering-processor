import { createApp } from './app.module.ts';

const app = await createApp();
await app.listen(Number(process.env.PORT ?? 3000));
