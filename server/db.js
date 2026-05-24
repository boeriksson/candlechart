import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, BatchWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
  },
});

const ddb = DynamoDBDocumentClient.from(client);
let available = false;
export const isDbAvailable = () => available;

async function ensureTable(name, keySchema, attrDefs) {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') {
      await client.send(new CreateTableCommand({
        TableName: name,
        KeySchema: keySchema,
        AttributeDefinitions: attrDefs,
        BillingMode: 'PAY_PER_REQUEST',
      }));
      console.log(`Created DynamoDB table: ${name}`);
    } else throw e;
  }
}

export async function initDb() {
  try {
    await ensureTable('bars',
      [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'time', KeyType: 'RANGE' }],
      [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'time', AttributeType: 'N' }]);

    await ensureTable('market_states',
      [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }],
      [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'date', AttributeType: 'N' }]);

    await ensureTable('markov',
      [{ AttributeName: 'pk', KeyType: 'HASH' }],
      [{ AttributeName: 'pk', AttributeType: 'S' }]);

    available = true;
    console.log('DynamoDB connected');
  } catch (e) {
    console.warn(`DynamoDB unavailable — caching disabled (${e.message})`);
  }
}

// --- Bars ---

function barsPk(symbol, exchange, timeframe) {
  return `${symbol}#${exchange}#${timeframe}`;
}

export async function getBars(symbol, exchange, timeframe) {
  if (!available) return [];
  const result = await ddb.send(new QueryCommand({
    TableName: 'bars',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': barsPk(symbol, exchange, timeframe) },
    ScanIndexForward: true,
  }));
  return (result.Items || []).map(({ time, open, high, low, close, volume }) => {
    // Auto-fix legacy YYYYMMDD integers stored before parseIBTime was corrected
    if (time >= 19000101 && time <= 21001231) {
      const s = String(time);
      time = Math.floor(new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`).getTime() / 1000);
    }
    return { time, open, high, low, close, volume };
  });
}

export async function putBar(symbol, exchange, timeframe, bar) {
  if (!available) return;
  await ddb.send(new PutCommand({
    TableName: 'bars',
    Item: { pk: barsPk(symbol, exchange, timeframe), ...bar },
  }));
}

export async function putBars(symbol, exchange, timeframe, bars) {
  if (!available || !bars.length) return;
  const key = barsPk(symbol, exchange, timeframe);
  for (let i = 0; i < bars.length; i += 25) {
    const chunk = bars.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        bars: chunk.map(bar => ({ PutRequest: { Item: { pk: key, ...bar } } })),
      },
    }));
  }
}

// --- Market states ---

function statesPk(symbol, exchange) {
  return `${symbol}#${exchange}`;
}

export async function putStates(symbol, exchange, states) {
  if (!available || !states.length) return;
  const key = statesPk(symbol, exchange);
  for (let i = 0; i < states.length; i += 25) {
    const chunk = states.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        market_states: chunk.map(s => ({
          PutRequest: { Item: { pk: key, date: s.date, state: s.state, dailyReturn: s.dailyReturn, cum20dReturn: s.cum20dReturn } },
        })),
      },
    }));
  }
}

export async function getStates(symbol, exchange) {
  if (!available) return [];
  const result = await ddb.send(new QueryCommand({
    TableName: 'market_states',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': statesPk(symbol, exchange) },
    ScanIndexForward: true,
  }));
  return result.Items || [];
}

// --- Markov ---

export async function getMarkov(symbol, exchange) {
  if (!available) return null;
  const result = await ddb.send(new GetCommand({
    TableName: 'markov',
    Key: { pk: statesPk(symbol, exchange) },
  }));
  return result.Item || null;
}

export async function putMarkov(symbol, exchange, data) {
  if (!available) return;
  await ddb.send(new PutCommand({
    TableName: 'markov',
    Item: { pk: statesPk(symbol, exchange), ...data },
  }));
}
