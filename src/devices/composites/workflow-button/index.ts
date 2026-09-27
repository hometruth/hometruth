import { Button, type ButtonPressOptions } from "../../../models/button";
import { CapabilityError, combinedAvailability, type Availability } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { buttonSchema, workflowSchema } from "../../../schemas";
import { validateWorkflow, WorkflowRunner, type WorkflowDefinition, type WorkflowRunView } from "../../../workflows/runner";

const workflowDefinitionForConfig = { ...workflowSchema } as const;

export const WORKFLOW_BUTTON_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/workflow-button/config",
  title: "Workflow Button config",
  type: "object",
  additionalProperties: false,
  properties: {
    workflow: workflowDefinitionForConfig,
  },
  required: ["workflow"],
} as const;

export interface WorkflowButtonConfig {
  readonly workflow: WorkflowDefinition;
}

function workflowTargets(workflow: WorkflowDefinition): string[] {
  return [...new Set(workflow.nodes.flatMap((node) => node.type === "action" || node.type === "condition" ? [node.device] : []))];
}

export class WorkflowButton extends Button {
  constructor(
    id: string,
    readonly config: WorkflowButtonConfig,
    private readonly devices: ReadonlyMap<string, Device>,
  ) {
    super(id);
    validateWorkflow(config.workflow as unknown as WorkflowDefinition);
    this.runner = new WorkflowRunner(this.workflow, devices);
  }

  protected override async performPress(_options: ButtonPressOptions): Promise<void> {
    this.runner.start();
  }

  /** Reachable exactly when every device the workflow touches is. */
  protected override async availability(): Promise<Availability> {
    const statuses = await Promise.all([...this.devices.values()].map((device) => device.availability()));
    return combinedAvailability(statuses);
  }

  get workflow(): WorkflowDefinition { return this.config.workflow as unknown as WorkflowDefinition; }
  get run(): WorkflowRunView { return this.runner.status(); }
  get runs(): readonly WorkflowRunView[] { return this.runner.history(); }
  cancelRun(id?: string): boolean { return this.runner.cancel(id); }

  private readonly runner: WorkflowRunner;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkflowButtonDevice extends CapabilityMethods<{ button: WorkflowButton }> {}

export class WorkflowButtonDevice extends Device<WorkflowButtonConfig> {
  readonly model = WORKFLOW_BUTTON;
  readonly capabilities;
  readonly button: WorkflowButton;
  private readonly targets: Map<string, Device>;

  constructor(instance: DeviceInstance, config: WorkflowButtonConfig, _services: SiteServices, context: DeviceCreationContext | undefined) {
    super(instance.id, instance.name, config);
    if (!context) throw new CapabilityError("A workflow Button must be provisioned as part of a site", "not_supported");
    const workflow = config.workflow as unknown as WorkflowDefinition;
    validateWorkflow(workflow);
    this.targets = new Map(workflowTargets(workflow).map((id) => [id, context.device(id, { relation: "uses" })]));
    for (const node of workflow.nodes) if (node.type === "action") this.targets.get(node.device)!.resolveControl(node.control);
    this.button = new WorkflowButton(instance.id, config, this.targets);
    this.capabilities = this.expose({ button: this.button });
  }

  override async probe(): Promise<DeviceIdentity> { return {}; }
  override displayHost(): string { return `${this.config.workflow.nodes.length} workflow nodes`; }
  override async close(): Promise<void> { this.button.cancelRun(); }
}

export const WORKFLOW_BUTTON: DeviceModel<WorkflowButtonConfig> = {
  id: "workflow-button",
  title: "Workflow Button",
  manufacturer: "HomeTruth",
  product: "Workflow Button",
  capabilities: ["button"],
  connectionTypes: ["composed"],
  configSchema: WORKFLOW_BUTTON_CONFIG_SCHEMA,
  objectSchemaId: buttonSchema.$id,
  create(instance: DeviceInstance, config: WorkflowButtonConfig, services: SiteServices, _secrets: SecretsBag, context?: DeviceCreationContext): WorkflowButtonDevice {
    return new WorkflowButtonDevice(instance, config, services, context);
  },
};
