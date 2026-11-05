import React, { useEffect, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import { useStreamerStore } from '@/store/streamer';
import { getStreamerStatus } from '@/services/streamer';
import { useFollowsWithStatus } from '@/hooks/useFollowsWithStatus';
import { normalizeUniqueId, isValidUniqueId } from '@/utils/followRecord';
import { requestLiveNotifyPermission } from '@/services/subscribeNotify';
import { getQuota, QuotaInfo } from '@/services/notifyQuota';
import { SUBS_TEMPLATE_ID } from '@/constants/notify';
import StreamerCard from '@/components/StreamerCard';
import EmptyState from '@/components/EmptyState';
import styles from './index.module.scss';

const SubscribePage: React.FC = () => {
  const { isFollowed, toggleFollow } = useStreamerStore();
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState(false);
  // 订阅额度账本（推送前可见的可推送条数；null=读取失败，显示中性文案）
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  // 关注列表（服务端持久化）+ 实时状态，与首页同一套逻辑
  const { list, setStatus, loading } = useFollowsWithStatus();

  const livingCount = list.filter((s) => s.status === 'living').length;

  // 订阅消息能力只有微信端有，且模板 ID 已配置才展示入口
  const canNotify = process.env.TARO_ENV === 'weapp' && SUBS_TEMPLATE_ID !== '';

  // 打开页面自动补攒一条额度（静默，不出提示）+ 顺路刷新额度显示：
  // 勾过「总是允许」的用户每次进来无感 +1；未勾选的用户微信会忽略无手势调用。
  // 手动点「开启」仍是主要入口，这里只是兜底增厚额度池。
  useEffect(() => {
    let alive = true;
    (async () => {
      if (canNotify) {
        await requestLiveNotifyPermission({ silent: true });
        const q = await getQuota();
        if (alive) setQuota(q);
      }
    })();
    return () => {
      alive = false;
    };
    // 仅页面首次挂载（tabBar 页面只 mount 一次）时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 校验输入，返回可用的抖音号；不合法时给出提示并返回空串 */
  const validateInput = (raw: string): string => {
    const uniqueId = normalizeUniqueId(raw);
    if (!isValidUniqueId(uniqueId)) {
      Taro.showToast({ title: '请输入抖音号', icon: 'none' });
      return '';
    }
    if (isFollowed(uniqueId)) {
      Taro.showToast({ title: '已经关注过了', icon: 'none' });
      return '';
    }
    return uniqueId;
  };

  const handleAdd = async () => {
    const uniqueId = validateInput(input);
    if (!uniqueId) return;

    setAdding(true);
    try {
      // 先校验抖音号是否存在，同时拿到真实昵称/头像（失败必须报错，不能假装成功）
      const info = await getStreamerStatus({ uniqueId });
      await toggleFollow({
        uniqueId,
        name: info.nickname || uniqueId,
        avatar: info.avatar,
        roomUrl: info.roomUrl
      });
      setStatus(uniqueId, info);
      setInput('');
      Taro.showToast({ title: '关注成功', icon: 'success' });
    } catch (e: any) {
      Taro.showToast({ title: e?.message || '添加失败，请检查抖音号', icon: 'none' });
    } finally {
      setAdding(false);
    }
  };

  /** 开启订阅消息：一次「允许」攒一条推送额度，云端巡检开播时消费 */
  const handleEnableNotify = async () => {
    if (notifyBusy) return;
    setNotifyBusy(true);
    try {
      const result = await requestLiveNotifyPermission();
      // 攒成功后立即刷新账本显示（accept 时 subscribeNotify 内部已记账）
      if (result === 'accepted') {
        setQuota(await getQuota());
      }
    } finally {
      setNotifyBusy(false);
    }
  };

  return (
    <View className={styles.page}>
      <View className={styles.notifyBar}>
        <View className={styles.notifyInfo}>
          <Text className={styles.notifyIcon}>🔔</Text>
          <View>
            <Text className={styles.notifyText}>开播提醒</Text>
            <Text className={styles.notifySub}>云端每分钟巡检，开播推送微信</Text>
          </View>
        </View>
        {canNotify && (
          <View
            className={classnames(styles.notifyAction, notifyBusy && styles.notifyActionDisabled)}
            hoverClass={styles.pressed}
            hoverStayTime={80}
            onClick={handleEnableNotify}
          >
            {notifyBusy ? '…' : '开启'}
          </View>
        )}
      </View>

      {/* 额度账本可视化：余量越保守越安全（43101 校准兜底），虚低提示引导用户攒 */}
      {canNotify && quota && (
        <View className={styles.quotaChip}>
          <Text className={styles.quotaNum}>
            {quota.quota > 0 ? `${quota.quota} 条可推` : '0 条可推'}
          </Text>
          <Text className={styles.quotaHint}>
            {quota.quota > 0
              ? `已推送 ${quota.totalSpent} 次 · 打开本页自动续攒`
              : '点「开启」或下次打开本页攒额度'}
          </Text>
        </View>
      )}

      <View className={styles.addBar}>
        <Input
          className={styles.addInput}
          placeholder="输入抖音号，如 54681081079"
          value={input}
          onInput={(e) => setInput(e.detail.value)}
          confirmType="done"
          onConfirm={handleAdd}
        />
        <View
          className={classnames(styles.addBtn, adding && styles.addBtnDisabled)}
          hoverClass={styles.pressed}
          hoverStayTime={80}
          onClick={adding ? undefined : handleAdd}
        >
          {adding ? '添加中' : '添加'}
        </View>
      </View>

      {list.length > 0 && (
        <View className={styles.sectionTitle}>
          {/* Text 里不能嵌套 View（小程序渲染层不支持），改用纯文本 */}
          <Text>共 {list.length} 位订阅</Text>
          {livingCount > 0 && (
            <Text className={styles.liveTag}>· {livingCount} 位直播中</Text>
          )}
        </View>
      )}

      <View className={styles.list}>
        {list.length > 0 ? (
          list.map((s) => (
            <StreamerCard
              key={s.uniqueId}
              streamer={s}
              isFollowed={isFollowed(s.uniqueId)}
              onFollow={toggleFollow}
            />
          ))
        ) : loading ? (
          <EmptyState text="加载中…" icon="⏳" />
        ) : (
          <EmptyState text="还没有关注的主播，输入抖音号添加" icon="⭐" />
        )}
      </View>
    </View>
  );
};

export default SubscribePage;