/** Peta rute internal → komponen modul. */
import type { ComponentType } from 'react';
import { BalancedScorecardView, ExecutiveCockpitView, OperationalCockpitView } from './leadership.tsx';
import { DataModelingView, DataQualityView, DatasetView, ExternalConnectionView, KpiCenterView } from './data.tsx';
import { DescriptiveStatisticsView, HypothesisTestingView, RegressionView } from './statistics.tsx';
import {
  AiAnalyticsView, AlertCenterView, AuditLogView, AuthorizationView, BillingView,
  DashboardDesignerView, DeviceView, DigitalTwinView, DiscoveryView, EmbedView,
  EmployeeView, ForecastView, NarrativeView, RcaView, ReportDesignerView,
  SubscriptionView, TenantView, UsageView, VisualizationView,
} from './remaining.tsx';

export const VIEWS: Record<string, ComponentType> = {
  exec: ExecutiveCockpitView,
  ops: OperationalCockpitView,
  bsc: BalancedScorecardView,
  designer: DashboardDesignerView,
  report: ReportDesignerView,
  viz: VisualizationView,
  embed: EmbedView,
  ai: AiAnalyticsView,
  forecast: ForecastView,
  rca: RcaView,
  discovery: DiscoveryView,
  narrative: NarrativeView,
  descstat: DescriptiveStatisticsView,
  hypo: HypothesisTestingView,
  regression: RegressionView,
  dataset: DatasetView,
  external: ExternalConnectionView,
  datamodel: DataModelingView,
  dataquality: DataQualityView,
  kpi: KpiCenterView,
  alert: AlertCenterView,
  twin: DigitalTwinView,
  employee: EmployeeView,
  auth: AuthorizationView,
  auditlog: AuditLogView,
  device: DeviceView,
  tenant: TenantView,
  subscription: SubscriptionView,
  billing: BillingView,
  usage: UsageView,
};
