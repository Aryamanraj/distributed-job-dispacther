import type {
	DeepPartial,
	EntityManager,
	EntityTarget,
	FindManyOptions,
	FindOneOptions,
	FindOptionsWhere,
	ObjectLiteral,
} from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";
import { logger } from "../../../util/logger";
import { AppDataSource } from "../data-source";
import type { ResultWithError } from "./types";

export abstract class BaseRepoService<T extends ObjectLiteral> {
	protected abstract readonly entityName: string;
	protected abstract readonly entityTarget: EntityTarget<T>;

	protected repo(em?: EntityManager) {
		if (em) return em.getRepository<T>(this.entityTarget);
		return AppDataSource.getRepository<T>(this.entityTarget);
	}

	async get(
		options: FindOneOptions<T>,
		panic = true,
		em?: EntityManager,
	): Promise<ResultWithError<T>> {
		try {
			const result = await this.repo(em).findOne(options);
			if (!result && panic) throw new Error(`${this.entityName} not found`);
			return { data: result ?? null, error: null };
		} catch (error) {
			logger.error({ err: error }, `Error finding ${this.entityName}`);
			return { data: null, error: error as Error };
		}
	}

	async getAll(
		options: FindManyOptions<T>,
		panic = true,
		em?: EntityManager,
	): Promise<ResultWithError<T[]>> {
		try {
			const result = await this.repo(em).find(options);
			if (result.length === 0 && panic)
				throw new Error(`No ${this.entityName} records found`);
			return { data: result, error: null };
		} catch (error) {
			logger.error({ err: error }, `Error finding all ${this.entityName}`);
			return { data: null, error: error as Error };
		}
	}

	async create(
		data: DeepPartial<T>,
		em?: EntityManager,
	): Promise<ResultWithError<T>> {
		try {
			const created = await this.repo(em).save(data);
			return { data: created as T, error: null };
		} catch (error) {
			logger.error({ err: error }, `Error creating ${this.entityName}`);
			return { data: null, error: error as Error };
		}
	}

	async insert(
		data: QueryDeepPartialEntity<T> | QueryDeepPartialEntity<T>[],
		em?: EntityManager,
	): Promise<{ error: Error | null }> {
		try {
			await this.repo(em).insert(data);
			return { error: null };
		} catch (error) {
			logger.error({ err: error }, `Error inserting ${this.entityName}`);
			return { error: error as Error };
		}
	}

	async upsert(
		data: QueryDeepPartialEntity<T> | QueryDeepPartialEntity<T>[],
		conflictPaths: string[],
		em?: EntityManager,
	): Promise<{ error: Error | null }> {
		try {
			await this.repo(em).upsert(data, conflictPaths);
			return { error: null };
		} catch (error) {
			logger.error({ err: error }, `Error upserting ${this.entityName}`);
			return { error: error as Error };
		}
	}

	async update(
		criteria: FindOptionsWhere<T>,
		partial: QueryDeepPartialEntity<T>,
		em?: EntityManager,
	): Promise<{ error: Error | null }> {
		try {
			await this.repo(em).update(criteria, partial);
			return { error: null };
		} catch (error) {
			logger.error({ err: error }, `Error updating ${this.entityName}`);
			return { error: error as Error };
		}
	}

	async delete(
		criteria: FindOptionsWhere<T>,
		em?: EntityManager,
	): Promise<{ error: Error | null }> {
		try {
			await this.repo(em).delete(criteria);
			return { error: null };
		} catch (error) {
			logger.error({ err: error }, `Error deleting ${this.entityName}`);
			return { error: error as Error };
		}
	}

	async count(
		options: FindManyOptions<T>,
		em?: EntityManager,
	): Promise<ResultWithError<number>> {
		try {
			const result = await this.repo(em).count(options);
			return { data: result, error: null };
		} catch (error) {
			logger.error({ err: error }, `Error counting ${this.entityName}`);
			return { data: null, error: error as Error };
		}
	}
}
