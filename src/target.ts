/**
 * GitLab CI Export Target
 *
 * Generates .gitlab-ci.yml from a Flow Weaver CI/CD workflow.
 * No FW runtime dependency — outputs native GitLab CI YAML.
 *
 * Key differences from GitHub Actions:
 * - `stage:` instead of job `needs:` (generates `stages:` list)
 * - `$CI_VARIABLE` instead of `${{ secrets.NAME }}`
 * - `cache:` and `artifacts:` as native YAML keywords (no separate actions)
 * - `services:` as native keyword
 * - `rules:` for conditional execution
 * - `environment:` as native keyword with `url:` and `when: manual` for approval
 */

import { stringify as yamlStringify } from 'yaml';
import type { TWorkflowAST } from '@synergenius/flow-weaver/ast';
import { isCICDWorkflow } from '@synergenius/flow-weaver/deployment';
import {
  BaseCICDTarget,
  type CICDJob,
  type CICDStep,
} from '@synergenius/flow-weaver/deployment';
import type {
  ExportOptions,
  ExportArtifacts,
  DeployInstructions,
} from '@synergenius/flow-weaver/deployment';
import { parseWorkflow } from '@synergenius/flow-weaver/api';
import * as path from 'path';

export class GitLabCITarget extends BaseCICDTarget {
  readonly name = 'gitlab-ci';
  readonly description = 'GitLab CI/CD pipeline (.gitlab-ci.yml)';

  readonly deploySchema = {
    runner: { type: 'string' as const, description: 'Default Docker image', default: 'ubuntu:latest' },
  };

  readonly nodeTypeDeploySchema = {
    script: { type: 'string[]' as const, description: 'GitLab CI script commands' },
    image: { type: 'string' as const, description: 'Docker image override' },
    label: { type: 'string' as const, description: 'Step display name' },
  };

  async generate(options: ExportOptions): Promise<ExportArtifacts> {
    const filePath = path.resolve(options.sourceFile);
    const outputDir = path.resolve(options.outputDir);

    // Parse the workflow file to get AST
    const parseResult = await parseWorkflow(filePath, { nodeTypesOnly: false });
    if (parseResult.errors.length > 0) {
      throw new Error(`Parse errors: ${parseResult.errors.join('; ')}`);
    }

    const allWorkflows = parseResult.allWorkflows || [];
    const targetWorkflows = options.workflowName
      ? allWorkflows.filter((w) => w.name === options.workflowName || w.functionName === options.workflowName)
      : allWorkflows.filter((w) => isCICDWorkflow(w));

    if (targetWorkflows.length === 0) {
      throw new Error('No CI/CD workflows found. Ensure workflow has CI/CD annotations (@secret, @runner, @trigger, [job:], etc.)');
    }

    const files = [];

    for (const ast of targetWorkflows) {
      // Build job graph
      const jobs = this.buildJobGraph(ast);

      // Resolve secrets
      this.resolveJobSecrets(jobs, ast, (name) => `$${name}`);

      // Inject artifacts
      const artifacts = ast.options?.cicd?.artifacts || [];
      this.injectArtifactSteps(jobs, artifacts);

      // Apply workflow options
      this.applyWorkflowOptions(jobs, ast);

      // Generate YAML
      const yamlContent = this.renderPipelineYAML(ast, jobs);

      files.push(this.createFile(outputDir, '.gitlab-ci.yml', yamlContent, 'config'));

      // Generate secrets doc if secrets exist
      const secrets = ast.options?.cicd?.secrets || [];
      if (secrets.length > 0) {
        const secretsDoc = this.generateSecretsDoc(secrets, 'gitlab-ci');
        files.push(this.createFile(outputDir, 'SECRETS_SETUP.md', secretsDoc, 'other'));
      }
    }

    return {
      files,
      target: this.name,
      workflowName: options.displayName || targetWorkflows[0].name,
      entryPoint: files[0].relativePath,
    };
  }

  getDeployInstructions(_artifacts: ExportArtifacts): DeployInstructions {
    return {
      title: 'Deploy GitLab CI Pipeline',
      prerequisites: [
        'GitLab repository',
        'CI/CD variables configured (see SECRETS_SETUP.md)',
        'GitLab Runner available (shared or project-specific)',
      ],
      steps: [
        'Copy .gitlab-ci.yml to your repository root',
        'Configure required variables in GitLab (Settings > CI/CD > Variables)',
        'Push to trigger the pipeline',
      ],
      localTestSteps: [
        'Install gitlab-runner: brew install gitlab-runner',
        'Run locally: gitlab-runner exec docker <job-name>',
      ],
      links: [
        { label: 'GitLab CI/CD Docs', url: 'https://docs.gitlab.com/ee/ci/' },
        { label: 'GitLab CI Lint', url: 'https://docs.gitlab.com/ee/ci/lint.html' },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Private: YAML Rendering
  // ---------------------------------------------------------------------------

  private renderPipelineYAML(ast: TWorkflowAST, jobs: CICDJob[]): string {
    const doc: Record<string, unknown> = {};

    // stages (derived from job dependency order)
    const stages = this.deriveStages(jobs);
    doc.stages = stages;

    // Default image
    const defaultImage = this.deriveDefaultImage(ast, jobs);
    if (defaultImage) {
      doc.default = { image: defaultImage };
    }

    // Workflow-level rules (from triggers)
    const rules = this.renderWorkflowRules(ast.options?.cicd?.triggers || []);
    if (rules.length > 0) {
      doc.workflow = { rules };
    }

    // Job definitions
    for (const job of jobs) {
      doc[job.id] = this.renderJob(job, ast, stages);
    }

    return yamlStringify(doc, {
      lineWidth: 120,
      defaultStringType: 'PLAIN',
      defaultKeyType: 'PLAIN',
    });
  }

  /**
   * Derive stages from job dependency order.
   * Jobs with no deps → stage 1, jobs depending on stage 1 → stage 2, etc.
   */
  private deriveStages(jobs: CICDJob[]): string[] {
    const stages: string[] = [];
    const assigned = new Map<string, string>();

    // Assign stages based on dependency depth
    function getStage(jobId: string, jobs: CICDJob[]): string {
      if (assigned.has(jobId)) return assigned.get(jobId)!;

      const job = jobs.find((j) => j.id === jobId);
      if (!job || job.needs.length === 0) {
        assigned.set(jobId, jobId);
        return jobId;
      }

      // Stage is one after the latest dependency
      const depStages = job.needs.map((dep) => getStage(dep, jobs));
      assigned.set(jobId, jobId);
      return jobId;
    }

    // Simple: use job IDs as stage names, ordered by dependency
    for (const job of jobs) {
      getStage(job.id, jobs);
      if (!stages.includes(job.id)) {
        stages.push(job.id);
      }
    }

    return stages;
  }

  /**
   * Derive default image from @deploy annotations or built-in mappings.
   */
  private deriveDefaultImage(_ast: TWorkflowAST, jobs: CICDJob[]): string | undefined {
    // Check steps for @deploy gitlab-ci image or built-in mapping
    for (const job of jobs) {
      for (const step of job.steps) {
        const mapping = this.resolveActionMapping(step, 'gitlab-ci');
        if (mapping?.gitlabImage) return mapping.gitlabImage;
      }
    }
    return undefined;
  }

  /**
   * Convert CI/CD triggers to GitLab CI workflow rules.
   */
  private renderWorkflowRules(
    triggers: Array<{ type: string; branches?: string[]; paths?: string[] }>,
  ): Array<Record<string, unknown>> {
    if (triggers.length === 0) return [];

    const rules: Array<Record<string, unknown>> = [];

    for (const trigger of triggers) {
      switch (trigger.type) {
        case 'push':
          if (trigger.branches) {
            for (const branch of trigger.branches) {
              rules.push({
                if: `$CI_COMMIT_BRANCH == "${branch}"`,
                when: 'always',
              });
            }
          } else {
            rules.push({ if: '$CI_PIPELINE_SOURCE == "push"', when: 'always' });
          }
          break;
        case 'pull_request':
          rules.push({
            if: '$CI_PIPELINE_SOURCE == "merge_request_event"',
            when: 'always',
          });
          break;
        case 'schedule':
          rules.push({
            if: '$CI_PIPELINE_SOURCE == "schedule"',
            when: 'always',
          });
          break;
        case 'dispatch':
          rules.push({
            if: '$CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api"',
            when: 'always',
          });
          break;
        case 'tag':
          rules.push({ if: '$CI_COMMIT_TAG', when: 'always' });
          break;
      }
    }

    return rules;
  }

  private renderJob(
    job: CICDJob,
    ast: TWorkflowAST,
    stages: string[],
  ): Record<string, unknown> {
    const jobObj: Record<string, unknown> = {};

    // stage
    jobObj.stage = job.id;

    // image (from runner or default)
    if (job.runner && job.runner !== 'ubuntu-latest') {
      // GitLab uses Docker images, not runner labels
      // Map common GitHub runners to Docker images
      const imageMap: Record<string, string> = {
        'ubuntu-latest': 'ubuntu:latest',
        'ubuntu-22.04': 'ubuntu:22.04',
        'ubuntu-20.04': 'ubuntu:20.04',
      };
      const image = imageMap[job.runner] || job.runner;
      jobObj.image = image;
    }

    // needs (for DAG mode instead of stage-based ordering)
    if (job.needs.length > 0) {
      jobObj.needs = job.needs;
    }

    // environment
    if (job.environment) {
      const envConfig = ast.options?.cicd?.environments?.find((e) => e.name === job.environment);
      const envObj: Record<string, unknown> = { name: job.environment };
      if (envConfig?.url) envObj.url = envConfig.url;
      if (envConfig?.reviewers) envObj.deployment_tier = 'production';
      jobObj.environment = envObj;
      // Protected environments require manual approval in GitLab
      if (envConfig?.reviewers) {
        jobObj.when = 'manual';
      }
    }

    // services
    if (job.services && job.services.length > 0) {
      jobObj.services = job.services.map((svc) => {
        const svcObj: Record<string, unknown> = { name: svc.image };
        if (svc.ports) {
          // GitLab services expose the first port automatically
          // Additional port mapping needs alias
        }
        return svcObj;
      });
    }

    // variables (from secrets)
    if (job.secrets.length > 0) {
      // In GitLab, CI/CD variables are automatically available
      // But we document them for clarity
      const variables: Record<string, string> = {};
      for (const secret of job.secrets) {
        variables[secret] = `$${secret}`;
      }
      jobObj.variables = variables;
    }

    // cache
    if (job.cache) {
      jobObj.cache = this.renderCache(job.cache);
    }

    // artifacts (upload)
    if (job.uploadArtifacts && job.uploadArtifacts.length > 0) {
      const paths = job.uploadArtifacts.map((a) => a.path);
      const expiry = job.uploadArtifacts[0].retention
        ? `${job.uploadArtifacts[0].retention} days`
        : '1 week';
      jobObj.artifacts = {
        paths,
        expire_in: expiry,
      };
    }

    // script (the actual steps)
    const script: string[] = [];

    // Download artifacts (GitLab handles this automatically via `needs:`)
    // but we add a comment for clarity if explicit artifacts are expected
    if (job.downloadArtifacts && job.downloadArtifacts.length > 0) {
      script.push(`# Artifacts from: ${job.downloadArtifacts.join(', ')} (downloaded automatically via needs:)`);
    }

    // Step scripts
    for (const step of job.steps) {
      const stepScript = this.renderStepScript(step);
      script.push(...stepScript);
    }

    jobObj.script = script;

    return jobObj;
  }

  private renderStepScript(step: CICDStep): string[] {
    const mapping = this.resolveActionMapping(step, 'gitlab-ci');
    const lines: string[] = [];

    // Add env vars as export statements if present
    if (step.env) {
      for (const [key, value] of Object.entries(step.env)) {
        lines.push(`export ${key}="${value}"`);
      }
    }

    if (mapping?.gitlabScript) {
      lines.push(`# ${mapping.label || step.name}`);
      lines.push(...mapping.gitlabScript);
    } else {
      // Unknown node type — generate TODO
      lines.push(`# TODO: Implement '${step.id}' (node type: ${step.nodeType})`);
      lines.push(`echo "Step: ${step.name}"`);
    }

    return lines;
  }

  private renderCache(cache: { strategy: string; key?: string; path?: string }): Record<string, unknown> {
    const cacheObj: Record<string, unknown> = {};

    switch (cache.strategy) {
      case 'npm':
        cacheObj.key = {
          files: [cache.key || 'package-lock.json'],
        };
        cacheObj.paths = [cache.path || 'node_modules/'];
        break;
      case 'pip':
        cacheObj.key = {
          files: [cache.key || 'requirements.txt'],
        };
        cacheObj.paths = [cache.path || '.pip-cache/'];
        break;
      default:
        cacheObj.key = cache.key || '$CI_COMMIT_REF_SLUG';
        cacheObj.paths = [cache.path || '.cache/'];
    }

    return cacheObj;
  }

  /**
   * Apply workflow-level options to jobs.
   */
  private applyWorkflowOptions(jobs: CICDJob[], ast: TWorkflowAST): void {
    const cicd = ast.options?.cicd;
    if (!cicd) return;

    // Apply cache to all jobs
    if (cicd.caches && cicd.caches.length > 0) {
      for (const job of jobs) {
        if (!job.cache) {
          job.cache = cicd.caches[0];
        }
      }
    }

    // Apply services to all jobs
    if (cicd.services && cicd.services.length > 0) {
      for (const job of jobs) {
        if (!job.services) {
          job.services = cicd.services;
        }
      }
    }

    // Apply matrix (GitLab uses `parallel: matrix:`)
    if (cicd.matrix) {
      const rootJobs = jobs.filter((j) => j.needs.length === 0);
      for (const job of rootJobs) {
        job.matrix = cicd.matrix;
      }
    }
  }
}

export default GitLabCITarget;
