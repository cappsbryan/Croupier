import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  GetCommandInput,
  GetCommandOutput,
  PutCommand,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommand,
  UpdateCommandInput,
  UpdateCommandOutput,
  DeleteCommand,
  DeleteCommandInput,
  DeleteCommandOutput,
  BatchWriteCommand,
  BatchWriteCommandInput,
  BatchWriteCommandOutput,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { chunked } from "./utils";

type OmitTableName<T> = Omit<T, "TableName">;

let cachedDynamoDbClient: ProjectTableClient | undefined;

export class ProjectTableClient {
  private tableName: string;
  private documentClient: DynamoDBDocumentClient;

  constructor(tableName: string) {
    this.tableName = tableName;
    const client = new DynamoDBClient({});
    this.documentClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  get(params: ProjectTableClient.GetItemInput): Promise<GetCommandOutput> {
    return this.documentClient.send(
      new GetCommand({
        ...params,
        TableName: this.tableName,
      })
    );
  }

  put(params: ProjectTableClient.PutItemInput): Promise<PutCommandOutput> {
    return this.documentClient.send(
      new PutCommand({
        ...params,
        TableName: this.tableName,
      })
    );
  }

  update(
    params: ProjectTableClient.UpdateItemInput
  ): Promise<UpdateCommandOutput> {
    return this.documentClient.send(
      new UpdateCommand({
        ...params,
        TableName: this.tableName,
      })
    );
  }

  delete(
    params: ProjectTableClient.DeleteItemInput
  ): Promise<DeleteCommandOutput> {
    return this.documentClient.send(
      new DeleteCommand({
        ...params,
        TableName: this.tableName,
      })
    );
  }

  async batchWrite(
    params: ProjectTableClient.BatchWriteItemInput
  ): Promise<(BatchWriteCommandOutput | undefined)[]> {
    const { RequestItems, ...otherParams } = params;

    let calls: Promise<BatchWriteCommandOutput | undefined>[] = [];
    const maxConcurrency = 4;
    for (let i = 0; i < maxConcurrency; i++) {
      const chunkedItems = chunked(RequestItems);
      const concurrentCalls: typeof calls = [];
      for (const chunk of chunkedItems) {
        const batchWriteCall = this.retryingBatchWrite({
          RequestItems: chunk,
          ...otherParams,
        });
        concurrentCalls.push(batchWriteCall);
      }
      calls.concat(concurrentCalls);
    }

    return await Promise.all(calls);
  }

  private async retryingBatchWrite(
    params: ProjectTableClient.BatchWriteItemInput
  ): Promise<BatchWriteCommandOutput | undefined> {
    const { RequestItems, ...otherParams } = params;
    const docParams = {
      RequestItems: {
        [this.tableName]: RequestItems,
      },
      ...otherParams,
    };

    let result: BatchWriteCommandOutput = {
      UnprocessedItems: docParams.RequestItems,
      $metadata: {},
    };
    try {
      result = await this.documentClient.send(new BatchWriteCommand(docParams));
    } catch (e) {
      if (
        !(e instanceof Error) ||
        e.name !== "ProvisionedThroughputExceededException"
      )
        throw e;
    }
    let backoff = 0.5;
    while (
      result.UnprocessedItems &&
      Object.keys(result.UnprocessedItems).length > 0 &&
      backoff < 64
    ) {
      backoff = backoff * 2;
      const unprocessedCount = Object.values(result.UnprocessedItems).reduce(
        (res, items) => res + items.length,
        0
      );
      console.info(
        `Retrying batch write after ${backoff} seconds`,
        `${unprocessedCount} unprocessed items`
      );
      await sleep((backoff + Math.random()) * 1000);
      try {
        result = await this.documentClient.send(
          new BatchWriteCommand({
            RequestItems: result.UnprocessedItems,
            ...otherParams,
          })
        );
      } catch (e) {
        if (
          !(e instanceof Error) ||
          e.name !== "ProvisionedThroughputExceededException"
        )
          throw e;
      }
    }

    if (
      result.UnprocessedItems &&
      Object.keys(result.UnprocessedItems).length > 0
    ) {
      console.warn("Batch write failed");
    }

    return result;
  }

  query(params: ProjectTableClient.QueryInput): Promise<QueryCommandOutput> {
    return this.documentClient.send(
      new QueryCommand({
        ...params,
        TableName: this.tableName,
      })
    );
  }

  async fullQuery(
    params: ProjectTableClient.QueryInput
  ): Promise<ProjectTableClient.FullQueryOutput> {
    let mergedResults = (await this.query(
      params
    )) as ProjectTableClient.FullQueryOutput;

    // handle paginated responses
    while (mergedResults.LastEvaluatedKey) {
      const nextResult = await this.query({
        ...params,
        ExclusiveStartKey: mergedResults.LastEvaluatedKey,
      });

      mergedResults.LastEvaluatedKey = nextResult.LastEvaluatedKey;
      mergedResults.Count =
        mergedResults.Count && nextResult.Count
          ? mergedResults.Count + nextResult.Count
          : undefined;
      mergedResults.ScannedCount =
        mergedResults.ScannedCount && nextResult.ScannedCount
          ? mergedResults.ScannedCount + nextResult.ScannedCount
          : undefined;
      mergedResults.Items =
        mergedResults.Items && nextResult.Items
          ? mergedResults.Items.concat(nextResult.Items)
          : undefined;
    }
    return mergedResults;
  }
}

export namespace ProjectTableClient {
  export type GetItemInput = OmitTableName<GetCommandInput>;
  export type PutItemInput = OmitTableName<PutCommandInput>;
  export type UpdateItemInput = OmitTableName<UpdateCommandInput>;
  export type DeleteItemInput = OmitTableName<DeleteCommandInput>;
  export type BatchWriteItemInput = Omit<
    BatchWriteCommandInput,
    "RequestItems"
  > & {
    RequestItems: NonNullable<BatchWriteCommandInput["RequestItems"]>[string];
  };
  export type QueryInput = OmitTableName<QueryCommandInput>;
  export type FullQueryOutput = Omit<QueryCommandOutput, "ConsumedCapacity">;
}

export function dynamoDbClient(): ProjectTableClient {
  if (cachedDynamoDbClient) return cachedDynamoDbClient;
  return new ProjectTableClient(
    process.env["DYNAMODB_PROJECT_TABLE"] as string
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
