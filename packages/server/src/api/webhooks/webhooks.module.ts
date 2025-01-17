import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/accounts.entity';
import { Audience } from '../audiences/entities/audience.entity';
import twilio from 'twilio';
import { WebhooksProcessor } from './webhooks.processor';
import { BullModule } from '@nestjs/bull';
import { TemplatesModule } from '../templates/templates.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Account, Audience]),
    BullModule.registerQueue({
      name: 'webhooks',
    }),
    TemplatesModule,
  ],
  providers: [WebhooksService, WebhooksProcessor],
  controllers: [WebhooksController],
  exports: [WebhooksService],
})
export class WebhooksModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(twilio.webhook())
      .forRoutes({ path: '/webhooks/twilio', method: RequestMethod.POST });
  }
}
