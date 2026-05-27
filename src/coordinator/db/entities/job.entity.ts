import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";

@Index("IX_Jobs_Status", ["Status"])
@Entity("Jobs")
export class Job {
	@PrimaryGeneratedColumn("uuid", { name: "JobID" })
	JobID: string;

	@Index("UQ_Jobs_IdempotencyKey", { unique: true })
	@Column({ name: "IdempotencyKey", type: "text" })
	IdempotencyKey: string;

	@Column({ name: "Payload", type: "jsonb" })
	Payload: Record<string, unknown>;

	@Column({ name: "Status", type: "text", default: "pending" })
	Status: string;

	@Column({ name: "Result", type: "jsonb", nullable: true })
	Result: Record<string, unknown>;

	@CreateDateColumn({ name: "CreatedAt", type: "timestamptz" })
	CreatedAt: Date;

	@UpdateDateColumn({ name: "UpdatedAt", type: "timestamptz" })
	UpdatedAt: Date;
}
