/**
 * 拍摄排期：把镜头指定到某个拍摄日，并记录当天的拍摄次序。
 * 一个镜头最多一条排期记录；未生成记录即「未安排日期」。
 */

/** 拍摄日（YYYY-MM-DD，本地时区）与当日次序 */
export interface ShotSchedule {
  id?: number;
  /** 关联镜头 id（唯一，一个镜头只排一天） */
  shotId: number;
  /** 镜号快照，便于通告单直接展示 */
  shotCode: string;
  /** 拍摄日，YYYY-MM-DD */
  shootDate: string;
  /** 当日拍摄次序，从 1 开始 */
  order: number;
  updatedAt: number;
}
