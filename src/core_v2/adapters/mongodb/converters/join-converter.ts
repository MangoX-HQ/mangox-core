/**
 * Core V2 - MongoDB Join Converter
 * Converts join clauses to MongoDB $lookup stages
 */

import { Document } from "mongodb";
import { JoinClause, JoinCondition } from "../../../query/intermediate";
import {
  IRelationshipRegistry,
  RelationshipDefinition,
} from "../../../interfaces/adapter.interface";
import { UserContext } from "../../../types";
import { MongoDBFilterConverter } from "./filter-converter";
import { appSettings } from "../../../../configs/app-settings";

// ============================================================================
// MONGODB JOIN CONVERTER
// ============================================================================

/**
 * MongoDB Join Converter
 * Converts join clauses to $lookup aggregation stages
 */
export class MongoDBJoinConverter {
  constructor(private relationshipRegistry: IRelationshipRegistry) {}

  /**
   * Convert join clauses to MongoDB $lookup stages
   */
  async convert(
    joins: JoinClause[],
    sourceCollection: string,
    user?: UserContext,
  ): Promise<Document[]> {
    const stages: Document[] = [];

    for (const join of joins) {
      const joinStages = await this.convertJoin(join, sourceCollection, user);
      stages.push(...joinStages);
    }

    return stages;
  }

  /**
   * Convert a single join clause
   */
  private async convertJoin(
    join: JoinClause,
    sourceCollection: string,
    user?: UserContext,
  ): Promise<Document[]> {
    const stages: Document[] = [];

    // Resolve relationship if specified
    let resolvedJoin = join;
    if (join.relationship?.name) {
      const relationship = this.relationshipRegistry.getByName(
        sourceCollection,
        join.relationship.name,
      );
      if (relationship) {
        resolvedJoin = this.applyRelationship(join, relationship);
      }
    }

    // Determine the output field name
    const outputField =
      resolvedJoin.alias || this.getOutputFieldName(resolvedJoin);

    // Get join conditions
    const conditions = resolvedJoin.on || [];

    if (conditions.length === 0) {
      // No conditions - skip this join
      return stages;
    }

    // Detect inverse relationship: localField is _id (ObjectId) and foreignField is a regular field (string)
    // This happens with mangox_ prefixed relationships (reverse direction)
    const isInverseLookup =
      conditions.length === 1 &&
      conditions[0].local === "_id" &&
      conditions[0].foreign !== "_id";

    if (conditions.length === 1) {
      if (isInverseLookup) {
        // Inverse lookup: localField is _id (ObjectId) → convert to string
        // so we can use localField/foreignField instead of slow $expr
        const conversionStage = this.buildObjectIdToStringStage(
          conditions[0].local,
        );
        if (conversionStage) {
          stages.push(conversionStage);
        }
      } else if (conditions[0].foreign === "_id") {
        // Normal lookup: localField stores string IDs → convert to ObjectId
        // Skip nested paths (e.g. tenant_roles.tenant_id) — $convert can't handle
        // paths through an array; the $lookup pipeline uses $toString itself to match
        // sang foreign _id (ObjectId).
        const localField = conditions[0].local;
        if (!localField.includes('.')) {
          const conversionStage = this.buildIdConversionStage(localField);
          if (conversionStage) {
            stages.push(conversionStage);
          }
        }
      }
    }

    // Build $lookup stage (with media path if target is media)
    // Nested joins are now handled inside buildLookupStage
    const isMediaLookup = resolvedJoin.target === "media";
    const lookupStage = await this.buildLookupStage(
      resolvedJoin,
      outputField,
      conditions,
      isMediaLookup,
      user,
      isInverseLookup,
    );
    stages.push(lookupStage);

    // Handle nested fields (e.g., session_tags.session_tags_work_location)
    // Merge the looked-up data back into the nested structure
    const localField = conditions[0]?.local;
    if (localField && localField.includes(".")) {
      const mergeStages = this.buildNestedFieldMergeStages(
        localField,
        outputField,
      );
      stages.push(...mergeStages);
      // Skip the standard join type processing since we've already handled it
      return stages;
    }

    // Handle join type specific processing
    switch (resolvedJoin.type) {
      case "one-to-one":
      case "many-to-one":
        // Unwind to get single object instead of array
        if (!isInverseLookup) {
          stages.push({
            $unwind: {
              path: `$${outputField}`,
              preserveNullAndEmptyArrays: true,
            },
          });
        }

        break;

      case "inner":
        // Remove documents without matches
        stages.push({
          $match: {
            [outputField]: { $ne: [], $exists: true },
          },
        });
        break;

      case "left":
      case "lookup":
      case "one-to-many":
      case "many-to-many":
        // Keep as array, no additional processing needed
        break;
    }

    // Note: Join filters (without ! prefix) are applied INSIDE the $lookup pipeline (buildLookupStage)
    // This ensures LEFT JOIN behavior - the original record isn't lost when joined data doesn't match the filter

    // Handle rootFilter for INNER JOIN behavior (! prefix in select syntax)
    // This filter is applied AFTER $unwind at root level, excluding records that don't match
    if (resolvedJoin.rootFilter) {
      const filterMatch = MongoDBFilterConverter.convert(
        resolvedJoin.rootFilter,
      );
      if (Object.keys(filterMatch).length > 0) {
        const prefixedFilter = this.prefixFilterFields(
          filterMatch,
          outputField,
        );
        stages.push({ $match: prefixedFilter });
      }
    }

    // Note: Nested joins are now handled inside buildLookupStage pipeline
    // Note: Projection for joined data is now handled inside $lookup pipeline

    // Clean up temp field from inverse lookup
    if (isInverseLookup) {
      stages.push({ $unset: `__${conditions[0].local}_str` });
    }

    return stages;
  }

  /**
   * Sensitive fields that should be excluded from user lookups
   */
  private static readonly SENSITIVE_FIELDS = [
    "password",
    "email",
    "role",
    "role_system",
  ];

  /**
   * Build $lookup stage
   * Supports nested joins inside pipeline for MongoDB 3.6+
   */
  private async buildLookupStage(
    join: JoinClause,
    outputField: string,
    conditions: JoinCondition[],
    isMediaLookup: boolean = false,
    user?: UserContext,
    isInverseLookup: boolean = false,
  ): Promise<Document> {
    // Check if this is a user lookup (needs sensitive fields filtering)
    const isUserLookup = join.target === "user" || join.target === "user_tenant";
    const hasNestedJoins = join.joins && join.joins.length > 0;

    // Tenant isolation: insert $match {tenant_id} into the pipeline if the target is
    // a tenant-scoped collection (resource.is_tenant=true). Prevents leaks when multiple
    // tenants share a single MongoDB DB. Returns null if not needed.
    const tenantFilterMatch = await this.buildTenantFilterMatch(user, join.target);

    // Simple lookup (single equality condition)
    if (
      conditions.length === 1 &&
      (!conditions[0].operator || conditions[0].operator === "eq")
    ) {
      const condition = conditions[0];

      // Check if we need a pipeline (for filters, media path, user sensitive fields, select, nested joins, etc.)
      const hasSelectFields =
        join.select?.include && join.select.include.length > 0;
      const needsPipeline =
        isMediaLookup ||
        join.filter ||
        isUserLookup ||
        hasSelectFields ||
        hasNestedJoins ||
        isInverseLookup ||
        !!tenantFilterMatch;

      if (needsPipeline) {
        const pipeline: Document[] = [];

        // Tenant isolation filter (placed as EARLY as possible so $match can leverage the index)
        if (tenantFilterMatch) {
          pipeline.push({ $match: tenantFilterMatch });
        }

        // Add filter if present (e.g., locale filter)
        if (join.filter) {
          const filterMatch = MongoDBFilterConverter.convert(join.filter);
          if (Object.keys(filterMatch).length > 0) {
            pipeline.push({ $match: filterMatch });
          }
        }

        // Add projection for join.select
        if (join.select?.include && join.select.include.length > 0) {
          const projection: Document = {};
          for (const field of join.select.include) {
            projection[field] = 1;
          }
          // Always include _id if not explicitly excluded
          if (!join.select.exclude?.includes("_id")) {
            projection._id = 1;
          }
          pipeline.push({ $project: projection });
        }

        // Add media path if target is media.
        // r2.dev domain is bound per-bucket so the object key must NOT include
        // bucketName — match the pattern used by media-minio.service getList.
        if (isMediaLookup) {
          const minioPublic = appSettings.minio.public || "";

          pipeline.push({
            $set: {
              path: {
                $ifNull: [
                  "$path",
                  {
                    $concat: [
                      minioPublic,
                      "/",
                      { $ifNull: ["$fileName", ""] },
                    ],
                  },
                ],
              },
            },
          });
        }

        // Exclude sensitive fields from user lookups
        if (isUserLookup) {
          const projection: Document = {};
          for (const field of MongoDBJoinConverter.SENSITIVE_FIELDS) {
            projection[field] = 0;
          }
          pipeline.push({ $project: projection });
        }

        // Handle nested joins INSIDE the pipeline
        if (hasNestedJoins) {
          for (const nestedJoin of join.joins!) {
            const nestedStages = await this.convertJoin(
              nestedJoin,
              join.target,
              user,
            );
            pipeline.push(...nestedStages);
          }
        }

        // Inverse lookup: _id already converted to string via $addFields
        // Use standard localField/foreignField (index-friendly)
        if (isInverseLookup) {
          const inverseTempField = `__${condition.local}_str`;
          return {
            $lookup: {
              from: join.target,
              localField: inverseTempField,
              foreignField: condition.foreign,
              pipeline: pipeline.length > 0 ? pipeline : undefined,
              as: outputField,
            },
          };
        }

        // Nested array path + foreign=_id: localField on array of strings doesn't
        // auto-match against ObjectId. Use $expr + $toString in let/pipeline.
        // Wrap the value into an array before $in: a single-select relation (e.g. session_tags.*)
        // stored as a plain string → $in throws "requires an array". Normalize:
        // missing/null → [], array → kept as-is, scalar → [scalar].
        const isNestedArrayId = condition.local.includes('.') && condition.foreign === '_id';
        if (isNestedArrayId) {
          const letVar = condition.local.replace(/\./g, '_');
          return {
            $lookup: {
              from: join.target,
              let: {
                [letVar]: {
                  $switch: {
                    branches: [
                      { case: { $eq: [{ $type: `$${condition.local}` }, 'missing'] }, then: [] },
                      { case: { $eq: [`$${condition.local}`, null] }, then: [] },
                      { case: { $isArray: `$${condition.local}` }, then: `$${condition.local}` },
                    ],
                    default: [`$${condition.local}`],
                  },
                },
              },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $in: [{ $toString: '$_id' }, `$$${letVar}`],
                    },
                  },
                },
                ...pipeline,
              ],
              as: outputField,
            },
          };
        }

        return {
          $lookup: {
            from: join.target,
            localField: condition.local,
            foreignField: condition.foreign,
            pipeline,
            as: outputField,
          },
        };
      }

      // Simple lookup without pipeline
      return {
        $lookup: {
          from: join.target,
          localField: condition.local,
          foreignField: condition.foreign,
          as: outputField,
        },
      };
    }

    // Complex lookup with pipeline
    const pipeline: Document[] = [];

    // Tenant isolation filter (placed as EARLY as possible)
    if (tenantFilterMatch) {
      pipeline.push({ $match: tenantFilterMatch });
    }

    // Build match conditions
    const matchConditions: Document[] = [];
    for (const condition of conditions) {
      matchConditions.push(this.buildLookupCondition(condition));
    }

    if (matchConditions.length > 0) {
      pipeline.push({
        $match: {
          $expr:
            matchConditions.length === 1
              ? matchConditions[0]
              : { $and: matchConditions },
        },
      });
    }

    // Add join filter if present
    if (join.filter) {
      const filterMatch = MongoDBFilterConverter.convert(join.filter);
      if (Object.keys(filterMatch).length > 0) {
        pipeline.push({ $match: filterMatch });
      }
    }

    // Add projection if present
    if (join.select?.include && join.select.include.length > 0) {
      const projection: Document = {};
      for (const field of join.select.include) {
        projection[field] = 1;
      }
      if (Object.keys(projection).length > 0) {
        pipeline.push({ $project: projection });
      }
    }

    // Exclude sensitive fields from user lookups
    if (isUserLookup) {
      const projection: Document = {};
      for (const field of MongoDBJoinConverter.SENSITIVE_FIELDS) {
        projection[field] = 0;
      }
      pipeline.push({ $project: projection });
    }

    // Handle nested joins INSIDE the pipeline
    if (hasNestedJoins) {
      for (const nestedJoin of join.joins!) {
        const nestedStages = await this.convertJoin(
          nestedJoin,
          join.target,
          user,
        );
        pipeline.push(...nestedStages);
      }
    }

    return {
      $lookup: {
        from: join.target,
        let: this.buildLetVariables(conditions),
        pipeline,
        as: outputField,
      },
    };
  }

  /**
   * Build condition for $lookup pipeline
   */
  private buildLookupCondition(condition: JoinCondition): Document {
    const localVar = `$$${condition.local.replace(/\./g, "_")}`;
    const foreignField = `$${condition.foreign}`;
    // Nested local path (vd tenant_roles.tenant_id) — array of strings vs
    // foreign _id (ObjectId). Use $in + $toString to match.
    const isNestedLocal = condition.local.includes('.');
    const isForeignId = condition.foreign === '_id';

    if (isNestedLocal && isForeignId && condition.operator === 'eq') {
      return { $in: [{ $toString: foreignField }, localVar] };
    }

    switch (condition.operator) {
      case "eq":
      default:
        return { $eq: [foreignField, localVar] };

      case "neq":
        return { $ne: [foreignField, localVar] };

      case "in":
        return { $in: [foreignField, localVar] };

      case "gt":
        return { $gt: [foreignField, localVar] };

      case "gte":
        return { $gte: [foreignField, localVar] };

      case "lt":
        return { $lt: [foreignField, localVar] };

      case "lte":
        return { $lte: [foreignField, localVar] };
    }
  }

  // ============================================================================
  // TENANT ISOLATION
  // ============================================================================

  /**
   * Build $match `{ tenant_id: <tenantId> }` for the $lookup pipeline when
   * user.tenant_id is present. Prevents cross-tenant leaks when multiple tenants share 1 DB.
   *
   * EXCLUDE: system collections (user, team, tenant, user_team) — they have no
   * tenant_id field since they live in the system DB. Applying the filter would make the JOIN return null.
   * Uses `$or` to allow both tenant-scoped records and system records (tenant_id null).
   */
  private async buildTenantFilterMatch(
    user: UserContext | undefined,
    target: string,
  ): Promise<Document | null> {
    const tenantId = user?.tenant_id;
    if (!tenantId) return null;
    const SYSTEM_COLLECTIONS = new Set(['user', 'team', 'tenant', 'user_team', 'role']);
    if (SYSTEM_COLLECTIONS.has(target)) return null;
    return {
      $or: [
        { tenant_id: tenantId },
        { tenant_id: { $exists: false } },
        { tenant_id: null },
      ],
    };
  }

  /**
   * Build let variables for $lookup pipeline
   */
  private buildLetVariables(conditions: JoinCondition[]): Document {
    const letVars: Document = {};

    for (const condition of conditions) {
      const varName = condition.local.replace(/\./g, "_");
      letVars[varName] = `$${condition.local}`;
    }

    return letVars;
  }

  /**
   * Get output field name for join
   */
  private getOutputFieldName(join: JoinClause): string {
    if (join.alias) return join.alias;

    // Use relationship name if available
    if (join.relationship?.name) {
      return join.relationship.name;
    }

    // Use target collection name
    return join.target;
  }

  /**
   * Apply relationship definition to join clause
   */
  private applyRelationship(
    join: JoinClause,
    relationship: RelationshipDefinition,
  ): JoinClause {
    return {
      ...join,
      target: join.target || relationship.targetCollection,
      type: join.type || relationship.type,
      on: join.on?.length
        ? join.on
        : [
            {
              local: relationship.localField,
              foreign: relationship.foreignField,
              operator: "eq",
            },
          ],
      relationship: {
        name: join.relationship?.name || relationship.name,
        ...join.relationship,
        junction: relationship.junction,
      },
    };
  }

  /**
   * Wrap filter in $elemMatch under the prefix key.
   * Used for rootFilter when joined field is an array (no $unwind).
   * Any element matching the condition causes the document to pass.
   */
  private prefixFilterFields(filter: Document, prefix: string): Document {
    return { [prefix]: { $elemMatch: filter } };
  }

  /**
   * Build projection for joined data
   */
  private buildJoinProjection(
    select: { include?: string[]; exclude?: string[] },
    outputField: string,
    joinType?: string,
  ): Document {
    const projection: Document = {};

    if (select.include && select.include.length > 0) {
      // Check if join type is one-to-one or many-to-one (single object)
      const isOneToOne =
        joinType === "one-to-one" || joinType === "many-to-one";

      if (isOneToOne) {
        // For one-to-one, use direct projection without $map
        const directFields: Document = {};
        for (const field of select.include) {
          directFields[field] = `$${outputField}.${field}`;
        }
        projection[outputField] = directFields;
      } else {
        // For one-to-many/many-to-many, use $map for array
        const fields: Document = {};
        for (const field of select.include) {
          fields[field] = `$$item.${field}`;
        }

        projection[outputField] = {
          $map: {
            input: `$${outputField}`,
            as: "item",
            in: fields,
          },
        };
      }
    }

    return projection;
  }

  /**
   * Build stages to merge looked-up data back into nested structure
   * For fields like session_tags.session_tags_work_location, this merges
   * the looked-up data from the temporary field back into the nested structure
   */
  private buildNestedFieldMergeStages(
    localField: string,
    outputField: string,
  ): Document[] {
    const parts = localField.split(".");
    if (parts.length < 2) return [];

    // 2-level array-of-objects case (e.g. tenant_roles[].tenant_id):
    //   parent = array of objects, leaf = field within each item.
    //   Replace each item.<leaf> with the joined doc looked up by _id from outputField.
    // Use $cond + $isArray to auto-fallback for the object-nested case (e.g. profile.course).
    if (parts.length === 2) {
      const [parentField, leafField] = parts;
      const arrayMap = {
        $map: {
          input: `$${parentField}`,
          as: 'item',
          in: {
            $mergeObjects: [
              '$$item',
              {
                [leafField]: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: `$${outputField}`,
                        as: 'joined',
                        cond: {
                          $eq: [
                            { $toString: '$$joined._id' },
                            { $toString: `$$item.${leafField}` },
                          ],
                        },
                      },
                    },
                    0,
                  ],
                },
              },
            ],
          },
        },
      };
      const objectMerge = {
        $mergeObjects: [
          `$${parentField}`,
          { [leafField]: `$${outputField}` },
        ],
      };
      return [
        {
          $set: {
            [parentField]: {
              $switch: {
                branches: [
                  // Array: $map per item with $filter lookup
                  { case: { $isArray: `$${parentField}` }, then: arrayMap },
                  // Object: deep merge with the joined doc
                  {
                    case: {
                      $and: [
                        { $ne: [{ $type: `$${parentField}` }, 'missing'] },
                        { $eq: [{ $type: `$${parentField}` }, 'object'] },
                      ],
                    },
                    then: objectMerge,
                  },
                ],
                // Missing/null parent → keep as-is (do NOT create an empty object)
                default: `$${parentField}`,
              },
            },
          },
        },
        { $unset: outputField },
      ];
    }

    // Object-nested deep path (≥3 levels): $mergeObjects deep chain.
    const buildDeepMerge = (
      fieldParts: string[],
      pathSoFar: string,
      value: string,
    ): Document => {
      if (fieldParts.length === 1) {
        return { [fieldParts[0]]: value };
      }
      const [current, ...rest] = fieldParts;
      const currentPath = pathSoFar ? `${pathSoFar}.${current}` : current;
      return {
        [current]: {
          $mergeObjects: [
            `$${currentPath}`,
            buildDeepMerge(rest, currentPath, value),
          ],
        },
      };
    };

    const mergeExpr = buildDeepMerge(parts, '', `$${outputField}`);
    return [
      { $set: mergeExpr },
      { $unset: outputField },
    ];
  }

  /**
   * Build $addFields stage to convert ObjectId to string
   * For inverse lookups: _id (ObjectId) → temporary string field
   * so we can use localField/foreignField (index-friendly) instead of $expr
   */
  private buildObjectIdToStringStage(field: string): Document | null {
    const tempField = `__${field}_str`;
    return {
      $addFields: {
        [tempField]: {
          $cond: {
            if: { $isArray: `$${field}` },
            then: {
              $map: {
                input: `$${field}`,
                as: "id",
                in: {
                  $cond: {
                    if: { $eq: [{ $type: "$$id" }, "objectId"] },
                    then: { $toString: "$$id" },
                    else: "$$id",
                  },
                },
              },
            },
            else: {
              $cond: {
                if: { $eq: [{ $type: `$${field}` }, "objectId"] },
                then: { $toString: `$${field}` },
                else: `$${field}`,
              },
            },
          },
        },
      },
    };
  }

  /**
   * Build $addFields stage to convert string IDs to ObjectId
   * This is needed for $lookup to work correctly when localField contains string IDs
   * but foreignField (_id) contains ObjectId
   */
  private buildIdConversionStage(field: string): Document | null {
    return {
      $addFields: {
        [field]: {
          $cond: {
            if: { $isArray: `$${field}` },
            then: {
              $map: {
                input: `$${field}`,
                as: "id",
                in: {
                  $cond: {
                    if: { $eq: [{ $type: "$$id" }, "string"] },
                    then: {
                      $convert: {
                        input: "$$id",
                        to: "objectId",
                        onError: "$$id",
                        onNull: "$$id",
                      },
                    },
                    else: "$$id",
                  },
                },
              },
            },
            else: {
              $cond: {
                if: { $eq: [{ $type: `$${field}` }, "string"] },
                then: {
                  $convert: {
                    input: `$${field}`,
                    to: "objectId",
                    onError: `$${field}`,
                    onNull: `$${field}`,
                  },
                },
                else: `$${field}`,
              },
            },
          },
        },
      },
    };
  }
}

/**
 * Create a new MongoDB join converter
 */
export function createMongoDBJoinConverter(
  relationshipRegistry: IRelationshipRegistry,
): MongoDBJoinConverter {
  return new MongoDBJoinConverter(relationshipRegistry);
}
