import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  LoggerService,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Account } from '../accounts/entities/accounts.entity';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import {
  Template,
  TemplateType,
  WebhookMethod,
} from './entities/template.entity';
import { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Installation } from '../slack/entities/installation.entity';
import { SlackService } from '../slack/slack.service';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { EventDto } from '../events/dto/event.dto';
import { Audience } from '../audiences/entities/audience.entity';
import { cleanTagsForSending } from '@/shared/utils/helpers';
import { fetch } from 'undici';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Liquid } from 'liquidjs';

@Injectable()
export class TemplatesService {
  private tagEngine = new Liquid();

  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
    @InjectRepository(Template)
    public templatesRepository: Repository<Template>,
    @InjectModel(Customer.name) public CustomerModel: Model<CustomerDocument>,
    @InjectRepository(Audience)
    private audiencesRepository: Repository<Audience>,
    @Inject(SlackService) private slackService: SlackService,
    @InjectQueue('message') private readonly messageQueue: Queue,
    @InjectQueue('slack') private readonly slackQueue: Queue,
    @InjectQueue('webhooks') private readonly webhooksQueue: Queue
  ) {}

  create(account: Account, createTemplateDto: CreateTemplateDto) {
    const template = new Template();
    template.type = createTemplateDto.type;
    template.name = createTemplateDto.name;
    switch (template.type) {
      case TemplateType.EMAIL:
        template.subject = createTemplateDto.subject;
        template.text = createTemplateDto.text;
        if (createTemplateDto.cc) template.cc = createTemplateDto.cc;
        template.style = createTemplateDto.style;
        break;
      case TemplateType.SLACK:
        template.slackMessage = createTemplateDto.slackMessage;
        break;
      case TemplateType.SMS:
        template.smsText = createTemplateDto.smsText;
        break;
      case TemplateType.FIREBASE:
        template.pushText = createTemplateDto.pushText;
        template.pushTitle = createTemplateDto.pushTitle;
        break;
      case TemplateType.WEBHOOK:
        template.webhookData = createTemplateDto.webhookData;
        break;
    }
    return this.templatesRepository.save({
      ...template,
      owner: { id: account.id },
    });
  }

  /**
   * Queues a message up to be sent to a customer using a template.
   *
   *  @remarks
   * If either the customer is not found or the template is not found
   * this will return an error.
   *
   * @param account - The owner of the audience
   * @param templateId - ID of template to send
   * @param customerId - ID of customer to send to
   *
   */
  async queueMessage(
    account: Account,
    templateId: string,
    customer: CustomerDocument,
    event: EventDto,
    audienceId?: string
  ): Promise<{ jobData: any; jobId: string | number }> {
    const customerId = customer.id;
    let template: Template,
      job: Job<any>, // created jobId
      installation: Installation,
      message: any;
    try {
      template = await this.findOneById(account, templateId);
      this.logger.debug(
        'Found template: ' + template.id + ' of type ' + template.type
      );
    } catch (err) {
      return Promise.reject(err);
    }
    const { _id, ownerId, audiences, ...tags } = customer.toObject();

    const filteredTags = cleanTagsForSending(tags);

    const {
      mailgunAPIKey,
      sendingName,
      testSendingEmail,
      testSendingName,
      sendgridApiKey,
      sendgridFromEmail,
      email,
    } = account;
    let { sendingDomain, sendingEmail } = account;

    let key = mailgunAPIKey;
    let from = sendingName;

    let jobData: any;

    switch (template.type) {
      case TemplateType.EMAIL:
        if (account.emailProvider === 'free3') {
          if (account.freeEmailsCount === 0)
            throw new HttpException(
              'You exceeded limit of 3 emails',
              HttpStatus.PAYMENT_REQUIRED
            );
          sendingDomain = process.env.MAILGUN_TEST_DOMAIN;
          key = process.env.MAILGUN_API_KEY;
          from = testSendingName;
          sendingEmail = testSendingEmail;
          account.freeEmailsCount--;
        }

        if (account.emailProvider === 'sendgrid') {
          key = sendgridApiKey;
          from = sendgridFromEmail;
        }

        job = await this.messageQueue.add('email', {
          accountId: account.id,
          audienceId,
          cc: template.cc,
          customerId,
          domain: sendingDomain,
          email: sendingEmail,
          eventProvider: account.emailProvider,
          from,
          trackingEmail: email,
          key,
          subject: template.subject,
          tags: filteredTags,
          templateId,
          text: template.text,
          to: customer.phEmail ? customer.phEmail : customer.email,
        });
        if (account.emailProvider === 'free3') await account.save();
        break;
      case TemplateType.SLACK:
        try {
          installation = await this.slackService.getInstallation(customer);
        } catch (err) {
          return Promise.reject(err);
        }
        job = await this.slackQueue.add('send', {
          accountId: account.id,
          args: {
            audienceId,
            channel: customer.slackId,
            customerId,
            tags: filteredTags,
            templateId,
            text: event?.payload ? event.payload : template.slackMessage,
          },
          methodName: 'chat.postMessage',
          token: installation.installation.bot.token,
          trackingEmail: email,
        });
        break;
      case TemplateType.SMS:
        job = await this.messageQueue.add('sms', {
          accountId: account.id,
          audienceId,
          customerId,
          from: account.smsFrom,
          sid: account.smsAccountSid,
          tags: filteredTags,
          templateId: template.id,
          text: template.smsText,
          to: customer.phPhoneNumber || customer.phone,
          token: account.smsAuthToken,
          trackingEmail: email,
        });
        break;
      case TemplateType.FIREBASE:
        job = await this.messageQueue.add('firebase', {
          accountId: account.id,
          audienceId,
          customerId,
          firebaseCredentials: account.firebaseCredentials,
          phDeviceToken: customer.phDeviceToken,
          pushText: template.pushText,
          pushTitle: template.pushTitle,
          trackingEmail: email,
          tags: filteredTags,
          templateId: template.id,
        });
        break;
      case TemplateType.WEBHOOK:
        if (template.webhookData) {
          job = await this.webhooksQueue.add('whapicall', {
            template,
            filteredTags,
            audienceId,
            customerId,
            accountId: account.id,
          });
          try {
            jobData = await job.finished();
          } catch {
            this.logger.warn('Error while retrieving webhook job data');
          }
        }
        break;
    }
    return Promise.resolve({
      jobData,
      jobId: message ? message?.sid : job?.id,
    });
  }

  async findAll(
    account: Account,
    take = 100,
    skip = 0,
    orderBy?: keyof Template,
    orderType?: 'asc' | 'desc',
    showDeleted?: boolean
  ): Promise<{ data: Template[]; totalPages: number }> {
    const totalPages = Math.ceil(
      (await this.templatesRepository.count({
        where: { owner: { id: account.id } },
      })) / take || 1
    );
    const orderOptions = {};
    if (orderBy && orderType) {
      orderOptions[orderBy] = orderType;
    }
    const templates = await this.templatesRepository.find({
      where: {
        owner: { id: account.id },
        isDeleted: In([!!showDeleted, false]),
      },
      order: orderOptions,
      take: take < 100 ? take : 100,
      skip,
    });
    return { data: templates, totalPages };
  }

  findOne(account: Account, name: string): Promise<Template> {
    return this.templatesRepository.findOneBy({
      owner: { id: account.id },
      name,
    });
  }

  findOneById(account: Account, id: string): Promise<Template> {
    return this.templatesRepository.findOneBy({
      owner: { id: account.id },
      id: id,
    });
  }

  findBy(account: Account, type: TemplateType): Promise<Template[]> {
    return this.templatesRepository.findBy({
      owner: { id: account.id },
      type: type,
    });
  }

  update(account: Account, name: string, updateTemplateDto: UpdateTemplateDto) {
    return this.templatesRepository.update(
      { owner: { id: (<Account>account).id }, name: name },
      { ...updateTemplateDto }
    );
  }

  async remove(account: Account, id: string): Promise<void> {
    await this.templatesRepository.update(
      {
        owner: { id: (<Account>account).id },
        id,
      },
      { isDeleted: true }
    );
  }

  async duplicate(account: Account, name: string) {
    const foundTemplate = await this.templatesRepository.findOne({
      where: {
        owner: { id: account.id },
        name,
      },
      relations: ['owner'],
    });
    if (!foundTemplate) throw new NotFoundException('Template not found');

    const { owner, slackMessage, style, subject, text, type, smsText } =
      foundTemplate;

    const ownerId = owner.id;

    let copyEraseIndex = foundTemplate.name.indexOf('-copy');
    if (copyEraseIndex === -1) copyEraseIndex = foundTemplate.name.length;

    const res = await this.templatesRepository
      .createQueryBuilder()
      .select('COUNT(*)')
      .where('starts_with(name, :oldName) = TRUE AND "ownerId" = :ownerId', {
        oldName: foundTemplate.name.substring(0, copyEraseIndex),
        ownerId: account.id,
      })
      .execute();

    const newName =
      foundTemplate.name.substring(0, copyEraseIndex) +
      '-copy-' +
      (res?.[0]?.count || '0');

    await this.templatesRepository.save({
      name: newName,
      owner: { id: ownerId },
      slackMessage,
      style,
      subject,
      text,
      type,
      smsText,
    });
  }

  async findUsedInJourneys(account: Account, id: string) {
    const template = await this.templatesRepository.findOneBy({
      id,
      owner: { id: account.id },
    });
    if (!template) throw new NotFoundException('Template not found');

    const data = await this.audiencesRepository
      .createQueryBuilder('audience')
      .select(`DISTINCT(workflow."name")`)
      .leftJoin(
        'audience_templates_template',
        'audience_templates_template',
        'audience_templates_template."audienceId" = audience.id'
      )
      .leftJoin('workflow', 'workflow', 'workflow.id = audience."workflowId"')
      .where(
        `workflow."isDeleted" = false AND audience."ownerId" = :ownerId AND audience_templates_template."templateId" = :templateId`,
        { ownerId: account.id, templateId: template.id }
      )
      .execute();

    return data.map((item) => item.name);
  }

  public async parseTemplateTags(str: string) {
    const matches = str.match(
      /\[\[\s(email|sms|slack|firebase);[a-zA-Z0-9-\s]+;[a-zA-Z]+\s\]\]/g
    );

    if (!matches) return str;

    for (const match of matches) {
      const [type, templateName, templateProperty] = match
        .replace('[[ ', '')
        .replace(' ]]', '')
        .trim()
        .split(';');

      const template = await this.templatesRepository.findOneBy({
        type: <TemplateType>type,
        name: templateName,
      });

      str = str.replace(match, template?.[templateProperty] || '');
    }

    return str;
  }

  async testWebhookTemplate(
    account: Account,
    id: string,
    testCustomerEmail: string
  ) {
    const template = await this.templatesRepository.findOneBy({
      owner: { id: account.id },
      id,
      type: TemplateType.WEBHOOK,
    });

    if (!template || !template.webhookData)
      throw new NotFoundException('Webhook template not found');

    const customer = await this.CustomerModel.findOne({
      email: testCustomerEmail,
    });

    if (!customer) throw new NotFoundException('Customer not found');

    const { _id, ownerId, audiences, ...tags } = customer.toObject();
    const filteredTags = cleanTagsForSending(tags);

    const { method } = template.webhookData;

    let { body, headers, url } = template.webhookData;

    url = await this.tagEngine.parseAndRender(url, filteredTags || {}, {
      strictVariables: true,
    });
    url = await this.parseTemplateTags(url);

    if (
      [
        WebhookMethod.GET,
        WebhookMethod.HEAD,
        WebhookMethod.DELETE,
        WebhookMethod.OPTIONS,
      ].includes(method)
    ) {
      body = undefined;
    } else {
      body = await this.parseTemplateTags(body);
      body = await this.tagEngine.parseAndRender(body, filteredTags || {}, {
        strictVariables: true,
      });
    }

    headers = Object.fromEntries(
      await Promise.all(
        Object.entries(headers).map(async ([key, value]) => [
          await this.parseTemplateTags(
            await this.tagEngine.parseAndRender(key, filteredTags || {}, {
              strictVariables: true,
            })
          ),
          await this.parseTemplateTags(
            await this.tagEngine.parseAndRender(value, filteredTags || {}, {
              strictVariables: true,
            })
          ),
        ])
      )
    );

    try {
      const res = await fetch(url, {
        method,
        body,
        headers,
      });

      return {
        body: await res.text(),
        headers: res.headers,
        status: res.status,
      };
    } catch (e) {
      throw new BadRequestException(e);
    }
  }
}
