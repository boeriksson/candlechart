import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
  },
});

const ddb = DynamoDBDocumentClient.from(client);
const TABLE = 'bars';
let available = false;
export const isDbAvailable = () => available;

export async function initDb() {
  try {
    try {
      await client.send(new DescribeTableCommand({ TableName: TABLE }));
    } catch (e) {
      if (e.name === 'ResourceNotFoundException') {
        await client.send(new CreateTableCommand({
          TableName: TABLE,
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'time', KeyType: 'RANGE' },
          ],
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'time', AttributeType: 'N' },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        }));
        console.log('Created DynamoDB table: bars');
      } else throw e;
    }
    available = true;
    console.log('DynamoDB connected');
  } catch (e) {
    console.warn(`DynamoDB unavailable — caching disabled (${e.message})`);
  }
}

function pk(symbol, exchange, timeframe) {
  return `${symbol}#${exchange}#${timeframe}`;
}

export async function getBars(symbol, exchange, timeframe) {
  if (!available) return [];
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': pk(symbol, exchange, timeframe) },
    ScanIndexForward: true,
  }));
  return (result.Items || []).map(({ time, open, high, low, close, volume }) =>
    ({ time, open, high, low, close, volume }));
}

export async function putBar(symbol, exchange, timeframe, bar) {
  if (!available) return;
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: pk(symbol, exchange, timeframe), ...bar },
  }));
}

export async function putBars(symbol, exchange, timeframe, bars) {
  if (!available || !bars.length) return;
  const key = pk(symbol, exchange, timeframe);
  for (let i = 0; i < bars.length; i += 25) {
    const chunk = bars.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE]: chunk.map(bar => ({ PutRequest: { Item: { pk: key, ...bar } } })),
      },
    }));
  }
}
