import { FastifyInstance } from 'fastify';

import { SettingRoutes } from '../module/_setting/setting.controller';
// FrontLayoutRoutes disabled: let /front/layout go through the wildcard FrontRoutesV2 + policy
// (policy-layout-guest has select=templates(...) to populate). Kept in sync with backend.
// import { FrontLayoutRoutes } from '../module/_front/front-layout.controller';
import { FrontSitemapRoutes } from '../module/_front/front-sitemap.controller';
import { FrontFormBuilderRoutes } from '../module/_front/front-form-builder.controller';
import { FrontCvRoutes } from '../module/_front/front-cv.controller';
import { FrontDetailRoutes } from '../module/_front/front-detail.controller';
import { FrontRoutesV2 } from '../module/_front/front.controller';
import { CommonRoutesV2 } from '../module/common_v2/common';
import { ApprovalRoutes } from '../module/_approval/approval.controller';
import { CronRoutes } from '../module/_cron/cron.controller';
import { AnalyticRoutes } from '../module/_analytic/analytic.controller';
export async function IndexRouteV2(app: FastifyInstance) {
  await SettingRoutes(app);
  // /approval/*, /cron/* — registered BEFORE the wildcard CommonRoutesV2
  await ApprovalRoutes(app);
  await CronRoutes(app);
  await AnalyticRoutes(app); // /analytic/* — before the wildcard
  // Specific /front/* TS controllers — MUST register before wildcard FrontRoutesV2
  // await FrontLayoutRoutes(app); // disabled: use generic front + policy (kept in sync with backend)
  await FrontSitemapRoutes(app);
  await FrontFormBuilderRoutes(app);
  await FrontCvRoutes(app);
  await FrontDetailRoutes(app);
  // Wildcard /front/* — data-driven via action.auth=false
  await FrontRoutesV2(app);
  await CommonRoutesV2(app);
}