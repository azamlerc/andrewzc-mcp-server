#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const mongoUri = process.env.MONGODB_URI;
const mongoDb = process.env.MONGODB_DB || 'andrewzc';
const openaiKey = process.env.OPENAI_API_KEY;

if (!mongoUri) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

if (!openaiKey) {
  console.error('OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

const client = new MongoClient(mongoUri);
const openai = new OpenAI({ apiKey: openaiKey });

class AndrewzcServer {
  constructor() {
    this.server = new Server(
      {
        name: 'andrewzc-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await client.close();
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'find_similar',
          description: 'Find entities similar to a given entity using vector similarity search. Returns entities ranked by semantic similarity based on Wikipedia content.',
          inputSchema: {
            type: 'object',
            properties: {
              list: {
                type: 'string',
                description: 'The list/collection name (e.g., "metros", "cities", "countries")',
              },
              entity_key: {
                type: 'string',
                description: 'The key of the entity to find similar items for (e.g., "london", "paris")',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return (default: 10)',
                default: 10,
              },
            },
            required: ['list', 'entity_key'],
          },
        },
        {
          name: 'semantic_search',
          description: 'Search for entities using natural language queries. Embeds the query text and finds semantically similar entities across all lists or within a specific list.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Natural language search query (e.g., "Victorian railway termini", "curved metro stations in Spain")',
              },
              list: {
                type: 'string',
                description: 'Optional: filter results to a specific list (e.g., "train-stations", "metros"). If omitted, searches all lists.',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return (default: 10)',
                default: 10,
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'find_similar') {
        return await this.handleFindSimilar(request.params.arguments);
      } else if (request.params.name === 'semantic_search') {
        return await this.handleSemanticSearch(request.params.arguments);
      } else {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }
    });
  }

  async handleFindSimilar(args) {
    const { list, entity_key, limit = 10 } = args;

    try {
      await client.connect();
      const db = client.db(mongoDb);
      const collection = db.collection('entities');

      // Get the source entity's embedding
      const source = await collection.findOne(
        { key: entity_key, list },
        { projection: { name: 1, wikiEmbedding: 1, icons: 1 } }
      );

      if (!source) {
        return {
          content: [
            {
              type: 'text',
              text: `Entity "${entity_key}" not found in ${list} list`,
            },
          ],
        };
      }

      if (!source.wikiEmbedding) {
        return {
          content: [
            {
              type: 'text',
              text: `Entity "${entity_key}" has no embedding`,
            },
          ],
        };
      }

      // Get page info for the source
      const sourcePage = await db.collection('pages').findOne({ key: list });
      const sourcePageIcon = sourcePage?.icon || '📋';
      const sourceEntityIcons = source.icons?.join('') || '';

      // Vector search
      const results = await collection.aggregate([
        {
          $vectorSearch: {
            index: 'wikiEmbedding',
            path: 'wikiEmbedding',
            queryVector: source.wikiEmbedding,
            numCandidates: limit * 5,
            limit: limit,
          },
        },
        {
          $project: {
            name: 1,
            list: 1,
            icons: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
        {
          $lookup: {
            from: 'pages',
            localField: 'list',
            foreignField: 'key',
            as: 'pageInfo',
          },
        },
        {
          $unwind: {
            path: '$pageInfo',
            preserveNullAndEmptyArrays: true,
          },
        },
      ]).toArray();

      // Format results
      let output = `🔍 Finding entities similar to: ${sourcePageIcon} ${sourcePage?.name || list} / ${sourceEntityIcons} ${source.name}\n\n`;
      output += 'Rank  Score   Page             Name\n';
      output += '─'.repeat(70) + '\n';

      results.forEach((result, i) => {
        const rank = (i + 1).toString().padStart(2);
        const score = result.score.toFixed(4);
        const pageIcon = result.pageInfo?.icon || '📋';
        const pageName = result.pageInfo?.name || result.list;
        const entityIcons = result.icons?.join('') || '';
        const page = `${pageIcon} ${pageName}`.padEnd(16);
        output += `${rank}.   ${score}  ${page} ${entityIcons} ${result.name}\n`;
      });

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleSemanticSearch(args) {
    const { query, list, limit = 10 } = args;

    try {
      await client.connect();
      const db = client.db(mongoDb);
      const collection = db.collection('entities');

      // Generate embedding for the query text
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query,
      });

      const queryEmbedding = embeddingResponse.data[0].embedding;

      // Build aggregation pipeline
      const pipeline = [
        {
          $vectorSearch: {
            index: 'wikiEmbedding',
            path: 'wikiEmbedding',
            queryVector: queryEmbedding,
            numCandidates: limit * 5,
            limit: limit,
          },
        },
        {
          $project: {
            name: 1,
            list: 1,
            icons: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ];

      // Add list filter if specified
      if (list) {
        pipeline.splice(1, 0, {
          $match: { list }
        });
      }

      // Add page lookup
      pipeline.push(
        {
          $lookup: {
            from: 'pages',
            localField: 'list',
            foreignField: 'key',
            as: 'pageInfo',
          },
        },
        {
          $unwind: {
            path: '$pageInfo',
            preserveNullAndEmptyArrays: true,
          },
        }
      );

      const results = await collection.aggregate(pipeline).toArray();

      // Format results
      let output = `🔍 Semantic search: "${query}"${list ? ` (filtered to: ${list})` : ''}\n\n`;
      output += 'Rank  Score   Page             Name\n';
      output += '─'.repeat(70) + '\n';

      results.forEach((result, i) => {
        const rank = (i + 1).toString().padStart(2);
        const score = result.score.toFixed(4);
        const pageIcon = result.pageInfo?.icon || '📋';
        const pageName = result.pageInfo?.name || result.list;
        const entityIcons = result.icons?.join('') || '';
        const page = `${pageIcon} ${pageName}`.padEnd(16);
        output += `${rank}.   ${score}  ${page} ${entityIcons} ${result.name}\n`;
      });

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Andrewzc MCP server running on stdio');
  }
}

const server = new AndrewzcServer();
server.run().catch(console.error);
