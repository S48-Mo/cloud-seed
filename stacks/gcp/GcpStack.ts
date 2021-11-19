import fs from "fs";
import { Construct } from "constructs";
import { GcsBackend, LocalBackend, TerraformStack } from "cdktf";
import {
  CloudfunctionsFunction,
  CloudfunctionsFunctionIamMember,
  CloudSchedulerJob,
  ComputeAddress,
  ComputeNetwork,
  ComputeRouter,
  ComputeRouterNat,
  GoogleProvider,
  PubsubTopic,
  SecretManagerSecret,
  SecretManagerSecretVersion,
  StorageBucket,
  StorageBucketObject,
  VpcAccessConnector,
} from "../../.gen/providers/google";
import { DataArchiveFile } from "../../.gen/providers/archive";
import { BigcommerceProvider, Webhook } from "../../.gen/providers/bigcommerce";
import { GcpConfig } from "../../runtime";
import { StackOptions, GcpFunction, FunctionTriggerConfig } from "./types";
import path from "path";

// Name is always defined by the bundler, so mark as required.
type RuntimeConfig = GcpConfig & { name: string };

const defaultStackOptions: StackOptions = {
  functionsDir: ".build/functions",
  environment: "dev",
  region: "europe-west2",
};

export default class GcpStack extends TerraformStack {
  private options: StackOptions;
  private projectId: string;
  private existingTopics: string[] = [];
  private existingBucketTriggers: string[] = [];
  private existingStaticIpConnectors: string[] = [];
  constructor(scope: Construct, name: string, options: Partial<StackOptions>) {
    super(scope, name);

    this.projectId = name;
    this.options = {
      ...defaultStackOptions,
      ...options,
    };

    // If bucket is defined,
    // then configure the remote backend where state will be stored,
    // else use a local backend.
    this.options.backendBucket?.length
      ? new GcsBackend(this, {
          bucket: this.options.backendBucket,
          prefix: this.options.backendPrefix,
        })
      : new LocalBackend(this, {
          path: path.join(this.options.functionsDir, "../"),
        });

    // Configure the Google Provider.
    new GoogleProvider(this, "GoogleAuth", {
      region: this.options.region,
      project: this.projectId,
    });

    // Creates a storage bucket for the functions to be uploaded to.
    const bucket = new StorageBucket(this, `${name}-functions`, {
      name: `${name}-functions`,
      location: "EU",
    });

    const functions = this.getFunctions();

    const hasWebhooks =
      functions.filter(func => func.type === "http" && func.webhook?.type === "bigcommerce")
        .length > 0;

    if (hasWebhooks) {
      new BigcommerceProvider(this, "bigcommerce");
    }

    functions.forEach(func => this.generateFunction(func, bucket, this.options));

    this.generateSecrets();
  }

  generateFunction(func: GcpFunction, bucket: StorageBucket, options: StackOptions) {
    const { functionsDir } = this.options;
    const functionDir = path.join(functionsDir, func.name);

    const artifactPath = path.join(this.options.functionsDir, `../artifacts/${func.name}.zip`);
    const archive = new DataArchiveFile(this, func.name + "zip", {
      type: "zip",
      outputPath: artifactPath.replace(/^.*\.build\//, ""),
      sourceDir: functionDir.replace(/^.*\.build\//, ""),
    });

    const object = new StorageBucketObject(this, func.name + "_storage_zip", {
      bucket: bucket.name,
      name: `${func.name}-${archive.outputMd5}.zip`,
      source: artifactPath.replace(/^.*\.build\//, ""),
    });

    const envVars = fs.existsSync("./env.json")
      ? JSON.parse(fs.readFileSync("./env.json").toLocaleString())?.[this.options.environment] ?? {}
      : {};

    const cloudFunc = new CloudfunctionsFunction(this, func.name + "-http", {
      name: func.name,
      runtime: func.runtime ?? "nodejs14",
      timeout: func.timeout ?? 60,
      sourceArchiveBucket: bucket.name,
      sourceArchiveObject: object.name,
      availableMemoryMb: func.memory ?? 256,
      entryPoint: "default",
      vpcConnector: func.staticIp ? "static-ip-connector" : undefined,
      vpcConnectorEgressSettings: func.staticIp ? "ALL_TRAFFIC" : undefined,
      environmentVariables: {
        NODE_ENV: this.options.environment,
        GCP_PROJECT: this.projectId,
        ...envVars,
      },

      ...this.generateFunctionTriggerConfig(func),
    });

    if (func.type === "http") {
      this.configureHttpFunction(func, cloudFunc);
    }

    // Create pubsub topics if they don't exist already.
    if (func.type === "event" && !this.existingTopics.includes(func.topicName)) {
      new PubsubTopic(this, func.topicName, {
        name: func.topicName,
      });
      this.existingTopics.push(func.topicName);
    }

    // Create cloud scheduler job + pubsub topic.
    if (func.type === "schedule") {
      const scheduledTopic = new PubsubTopic(this, func.name + "-schedule", {
        name: "scheduled-" + func.name,
      });
      new CloudSchedulerJob(this, func.name, {
        name: func.name,
        schedule: func.schedule,
        pubsubTarget: [
          {
            topicName: `projects/${this.projectId}/topics/${scheduledTopic.name}`,
            data: "c2NoZWR1bGU=",
          },
        ],
      });
    }

    if (func.type === "storage" && !this.existingBucketTriggers.includes(func.bucket)) {
      new StorageBucket(this, func.bucket, {
        name: func.bucket,
        location: "EU",
      });
      this.existingBucketTriggers.push(func.bucket);
    }

    if (func.staticIp && !this.existingStaticIpConnectors.length) {
      const region = options.region;
      const net = new ComputeNetwork(this, "static-ip-vpc", {
        name: "static-ip-vpc",
        autoCreateSubnetworks: false,
      });
      const staticIp = new ComputeAddress(this, "static-ip", {
        name: "static-ip",
        addressType: "EXTERNAL",
        region,
      });
      const router = new ComputeRouter(this, "static-ip-router", {
        name: "static-ip-router",
        network: net.id,
        region,
      });
      new ComputeRouterNat(this, "static-ip-nat", {
        name: "static-ip-nat",
        router: router.name,
        region: router.region,
        natIpAllocateOption: "MANUAL_ONLY",
        sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
        natIps: [staticIp.selfLink],
      });
      const connector = new VpcAccessConnector(this, "static-ip-connector", {
        name: "static-ip-connector",
        network: net.name,
        ipCidrRange: "10.1.1.0/28",
        region,
        minThroughput: 200,
        maxThroughput: 300,
      });
      this.existingStaticIpConnectors.push(connector.name);
    }
  }

  configureHttpFunction(config: RuntimeConfig, cloudFunction: CloudfunctionsFunction) {
    if (config.type !== "http") {
      return;
    }

    // Configure if the http function is publically invokable.
    if (config.public) {
      new CloudfunctionsFunctionIamMember(this, config.name + "-http-invoker", {
        cloudFunction: config.name,
        role: "roles/cloudfunctions.invoker",
        member: "allUsers",
      });
    }

    // BigCommerce Webhook support.
    if (config.webhook?.type === "bigcommerce") {
      config.webhook.scopes.forEach((scope, index) => {
        new Webhook(this, `${config.name}-webhook-${index}`, {
          scope,
          destination: cloudFunction.httpsTriggerUrl,
          isActive: true,
        });
      });
    }
  }

  generateFunctionTriggerConfig(config: RuntimeConfig): FunctionTriggerConfig {
    if (config.type === "http") {
      return {
        triggerHttp: true,
      };
    }

    let eventType = "providers/cloud.pubsub/eventTypes/topic.publish";
    let resource: string;
    switch (config.type) {
      case "event":
        resource = config.topicName;
        break;
      case "schedule":
        resource = "scheduled-" + config.name;
        break;
      case "firestore":
        eventType = `providers/cloud.firestore/eventTypes/document.${
          config.firestoreEvent ?? "write"
        }`;
        resource = config.document;
        break;
      case "storage":
        eventType = `google.storage.object.${config.storageEvent ?? "finalize"}`;
        resource = config.bucket;
        break;
    }

    return {
      eventTrigger: [{ eventType, resource }],
    };
  }

  /**
   * Generate secrets manager secrets. These can then be access by application code.
   * This expects an optional secrets.json file to exist in the root of the project.
   */
  generateSecrets() {
    // Don't generate secrets if there isn't a secrets json file.
    if (!fs.existsSync("./secrets.json")) {
      return;
    }

    const secrets = JSON.parse(fs.readFileSync("./secrets.json").toString()) as string[];
    secrets.forEach(secret => {
      if (typeof secret !== "string") {
        return;
      }

      const gcpSecret = new SecretManagerSecret(this, secret, {
        secretId: secret,
        replication: [{ automatic: true }],
      });

      new SecretManagerSecretVersion(this, secret + "-version", {
        secret: gcpSecret.id,
        secretData: "INITIAL_VALUE_DO_NOT_DELETE",
      });
    });
  }

  getFunctions(): (RuntimeConfig & { file: string; name: string })[] {
    const contents = fs.readFileSync(path.join(this.options.functionsDir, "../functions.json"));
    return JSON.parse(contents.toString());
  }
}
