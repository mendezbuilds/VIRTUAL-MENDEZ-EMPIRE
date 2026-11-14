import type { AgentSpec, Department } from '@vme/shared-types';

export const INITIAL_DEPARTMENTS: Department[] = [
  {
    id: 'executive_office',
    name: 'Executive Office',
    description: 'Autonomous corporate governance, strategy formulation, Owner reporting, and department direction',
    budgetMonthlyUsd: 10000,
    allowedCapabilities: ['strategic_planning', 'executive_reporting', 'budget_allocation', 'cross_dept_governance'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'financial_intelligence',
    name: 'Financial Intelligence',
    description: 'Treasury operations, immutable double-entry accounting, FX & Crypto market intelligence and paper trading',
    budgetMonthlyUsd: 50000,
    allowedCapabilities: ['ledger_accounting', 'treasury_management', 'fx_paper_trading', 'crypto_paper_trading', 'risk_auditing'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'technology_engineering',
    name: 'Technology & Engineering',
    description: 'Architecture, software engineering, continuous delivery, agent tooling and platform reliability',
    budgetMonthlyUsd: 25000,
    allowedCapabilities: ['software_architecture', 'code_generation', 'ci_cd_automation', 'platform_security'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'business_development',
    name: 'Business Development',
    description: 'Enterprise contract sourcing, B2B deal negotiation, partnerships, and subsidiary incubation',
    budgetMonthlyUsd: 15000,
    allowedCapabilities: ['deal_sourcing', 'b2b_negotiation', 'partnership_development', 'contract_drafting'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'marketing_growth',
    name: 'Marketing & Growth',
    description: 'Audience acquisition, brand consistency, social distribution, and multi-channel marketing campaigns',
    budgetMonthlyUsd: 12000,
    allowedCapabilities: ['content_strategy', 'social_distribution', 'brand_monitoring', 'campaign_management'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'operations_administration',
    name: 'Operations & Administration',
    description: 'Process optimization, corporate compliance, workflow coordination, and resource scheduling',
    budgetMonthlyUsd: 8000,
    allowedCapabilities: ['workflow_orchestration', 'compliance_monitoring', 'operational_audit', 'process_automation'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'opportunity_acquisition',
    name: 'Opportunity Acquisition',
    description: 'Dual-track acquisition engine: Track A (Owner jobs/contracts) & Track B (Empire B2B leads and bounties)',
    budgetMonthlyUsd: 10000,
    allowedCapabilities: ['job_market_scraping', 'outreach_drafting', 'lead_generation', 'bounty_hunting'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'research_intelligence',
    name: 'Research & Intelligence',
    description: 'Deep market analysis, competitive intelligence, algorithmic tokenomics, and intelligence dossiers',
    budgetMonthlyUsd: 7000,
    allowedCapabilities: ['market_forecasting', 'competitive_benchmarking', 'sentiment_analysis', 'dossier_compilation'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'security_governance',
    name: 'Security & Governance',
    description: 'Multi-tier circuit breakers, credential protection, RBAC/ABAC enforcement, and audit trail validation',
    budgetMonthlyUsd: 15000,
    allowedCapabilities: ['circuit_breaker_control', 'access_governance', 'security_audit', 'credential_isolation'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// Helper to construct AgentSpecs
function createAgent(
  id: string,
  name: string,
  departmentId: Department['id'],
  tier: AgentSpec['tier'],
  systemPrompt: string,
  allowedTools: string[]
): AgentSpec {
  return {
    id,
    name,
    departmentId,
    tier,
    systemPrompt,
    modelProvider: 'mock',
    modelId: 'mock-llm-v1',
    allowedTools,
    maxParallelTasks: tier === 'director' ? 5 : 3,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export const INITIAL_WORKFORCE: AgentSpec[] = [
  // 1. Executive Office
  createAgent(
    '00000000-0000-0000-0000-000000000001',
    'CEO_AutonomousDirector',
    'executive_office',
    'executive',
    'You are the CEO and Autonomous Director of Virtual Mendez Empire. You translate Owner directives into corporate strategy and hold all department directors accountable.',
    ['decompose_objective', 'delegate_task', 'approve_budget', 'compile_board_report']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000002',
    'ChiefOperatingOfficer',
    'executive_office',
    'director',
    'You are the COO of Virtual Mendez Empire. You oversee interdepartmental execution, resolve operational bottlenecks, and monitor company-wide SLAs.',
    ['inspect_operations', 'reassign_task', 'escalate_incident']
  ),

  // 2. Financial Intelligence
  createAgent(
    '00000000-0000-0000-0000-000000000003',
    'ChiefFinancialDirector',
    'financial_intelligence',
    'director',
    'You are the CFO and Director of Financial Intelligence. You safeguard the central treasury, enforce double-entry immutability, and manage financial risk.',
    ['approve_expenditure', 'audit_ledger', 'verify_hash_chain']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000004',
    'TreasuryAccountant',
    'financial_intelligence',
    'specialist',
    'You are the Treasury Accountant. You prepare double-entry journal postings in USD, NGN, and reserve currencies.',
    ['post_journal_entry', 'reconcile_balances']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000005',
    'FX_TradingAnalyst',
    'financial_intelligence',
    'specialist',
    'You are the FX Market Analyst. You backtest currency strategies and conduct simulated paper trading. Live trading is strictly prohibited.',
    ['backtest_fx', 'paper_trade_fx', 'analyze_forex_news']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000006',
    'CryptoDegenAnalyst',
    'financial_intelligence',
    'specialist',
    'You are the Crypto and DeFi Analyst. You research on-chain liquidity, tokenomics, and paper trade digital assets.',
    ['analyze_onchain_metrics', 'paper_trade_crypto', 'audit_smart_contract_risk']
  ),

  // 3. Technology & Engineering
  createAgent(
    '00000000-0000-0000-0000-000000000007',
    'ChiefTechnologyDirector',
    'technology_engineering',
    'director',
    'You are the CTO and Director of Technology & Engineering. You enforce software architecture, test coverage, and modular code hygiene.',
    ['review_architecture', 'enforce_testing_gate', 'approve_release']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000008',
    'SoftwareArchitectBot',
    'technology_engineering',
    'specialist',
    'You are the Lead Software Architect. You design data structures, API contracts, and scalable services.',
    ['design_system', 'write_adr', 'generate_schemas']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000009',
    'FullStackEngineerBot',
    'technology_engineering',
    'specialist',
    'You are the Full Stack Engineer. You implement clean TypeScript services, API endpoints, and database interactions.',
    ['implement_feature', 'write_unit_tests', 'refactor_code']
  ),

  // 4. Business Development
  createAgent(
    '00000000-0000-0000-0000-000000000010',
    'BusinessDevDirector',
    'business_development',
    'director',
    'You are the Director of Business Development. You drive enterprise client acquisition, strategic partnerships, and new venture revenue.',
    ['qualify_opportunity', 'approve_deal_structure', 'manage_pipeline']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000011',
    'PartnershipSourcingBot',
    'business_development',
    'specialist',
    'You are the Partnership Sourcing Specialist. You identify synergetic technology platforms and explore co-marketing or integration opportunities.',
    ['search_companies', 'evaluate_fit', 'draft_partnership_brief']
  ),

  // 5. Marketing & Growth
  createAgent(
    '00000000-0000-0000-0000-000000000012',
    'MarketingDirector',
    'marketing_growth',
    'director',
    'You are the Director of Marketing & Growth. You direct brand positioning, audience funnels, and corporate communications.',
    ['approve_campaign', 'review_copy', 'analyze_metrics']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000013',
    'ContentStrategistBot',
    'marketing_growth',
    'specialist',
    'You are the Content Strategist. You draft high-authority articles, technical announcements, and social content.',
    ['draft_article', 'create_thread', 'optimize_seo']
  ),

  // 6. Operations & Administration
  createAgent(
    '00000000-0000-0000-0000-000000000014',
    'OperationsDirector',
    'operations_administration',
    'director',
    'You are the Director of Operations. You orchestrate corporate workflows, regulatory compliance, and scheduling.',
    ['audit_process', 'schedule_automation', 'manage_resources']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000015',
    'WorkflowCoordinator',
    'operations_administration',
    'specialist',
    'You coordinate automated background tasks and monitor execution SLAs across departments.',
    ['track_sla', 'trigger_cron', 'archive_logs']
  ),

  // 7. Opportunity Acquisition
  createAgent(
    '00000000-0000-0000-0000-000000000016',
    'OpportunityDirector',
    'opportunity_acquisition',
    'director',
    'You are the Director of Opportunity Acquisition. You lead Track A (Owner career & contracts) and Track B (Empire enterprise leads).',
    ['review_lead_quality', 'approve_outreach_campaign', 'monitor_conversion']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000017',
    'OwnerJobScoutBot',
    'opportunity_acquisition',
    'specialist',
    'You are the Owner Job Scout. You search for high-paying remote roles in Rust, Web3, Python, and AI engineering for Stephen Mendez.',
    ['scan_job_boards', 'filter_by_compensation', 'extract_hiring_manager']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000018',
    'OwnerOutreachPreparerBot',
    'opportunity_acquisition',
    'specialist',
    'You draft tailored resumes, cover letters, and cold outreach emails. Consequential sending is blocked pending Owner approval.',
    ['draft_cover_letter', 'personalize_email', 'queue_for_approval']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000019',
    'EnterpriseLeadGenBot',
    'opportunity_acquisition',
    'specialist',
    'You identify startups and businesses needing autonomous AI or software engineering consulting.',
    ['discover_leads', 'enrich_company_data', 'draft_b2b_proposal']
  ),

  // 8. Research & Intelligence
  createAgent(
    '00000000-0000-0000-0000-000000000020',
    'ResearchDirector',
    'research_intelligence',
    'director',
    'You are the Director of Research & Intelligence. You synthesize market signals into strategic intelligence briefings.',
    ['commission_research', 'validate_hypothesis', 'publish_intelligence_dossier']
  ),
  createAgent(
    '00000000-0000-0000-0000-000000000021',
    'MarketForecasterBot',
    'research_intelligence',
    'specialist',
    'You track macroeconomic trends, interest rates, and AI industry developments.',
    ['gather_macro_data', 'forecast_trends', 'generate_summary']
  ),

  // 9. Security & Governance
  createAgent(
    '00000000-0000-0000-0000-000000000022',
    'ChiefSecurityDirector',
    'security_governance',
    'director',
    'You are the Chief Information Security Officer (CISO). You hold the authority to trigger multi-tier emergency halt and enforce security boundaries.',
    ['trigger_emergency_halt', 'audit_permissions', 'verify_token_integrity']
  ),
];
