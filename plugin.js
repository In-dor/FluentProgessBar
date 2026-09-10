plugin.onLoad(() => {
    // 1. 注入独立硬件加速图层与溢出裁切样式
    const styleEl = document.createElement('style');
    const hideOverflow = !("MaterialYouTheme" in loadedPlugins) ? "overflow-x: hidden;" : "";
    styleEl.id = 'fluent-progress-bar-style';
    styleEl.innerHTML = `
        .m-player .prg { ${hideOverflow} }
        .m-player .prg .has {
            width: 100% !important;
            transform-origin: left center !important;
            will-change: transform !important;
        }
        .m-player-fm .prg { ${hideOverflow} }
        .m-player-fm .prg .has {
            width: 100% !important;
            transform-origin: left center !important;
            will-change: transform !important;
        }
    `;
    document.head.appendChild(styleEl);

    const ANIM_MAX_LEN = 100000; // 100,000ms 虚拟动画时长，保证亚毫秒级平滑精度
    const DRIFT_THRESHOLD_SEC = 0.6; // 漂移阈值（秒），正常播放时不干扰合成器，只有手动跳转或切歌时校准

    let totalDuration = 0;
    let currentProgress = 0;
    let isPlaying = false;

    const barControllers = new Set();

    class ProgressBarController {
        constructor(eleHas) {
            this.eleHas = eleHas;
            this.elePrg = eleHas.closest('.prg') || eleHas.parentElement;
            this.isSeeking = false;
            this.needSyncAfterSeek = false;

            this.anim = eleHas.animate(
                [
                    { transform: 'translateX(-100%)' },
                    { transform: 'translateX(0%)' }
                ],
                {
                    duration: ANIM_MAX_LEN,
                    fill: 'both'
                }
            );
            this.anim.pause();

            this.setupEvents();
            if (totalDuration > 0) {
                this.syncRate(totalDuration);
                this.syncProgress(currentProgress, true);
                if (isPlaying && !document.hidden) {
                    this.anim.play();
                }
            }
        }

        syncRate(duration) {
            if (!duration || duration <= 0) return;
            const targetRate = ANIM_MAX_LEN / (duration * 1000);
            if (Math.abs(this.anim.playbackRate - targetRate) > 1e-7) {
                this.anim.playbackRate = targetRate;
            }
        }

        syncProgress(progress, force = false) {
            if (!totalDuration || totalDuration <= 0 || this.isSeeking) return;

            const targetTime = (progress / totalDuration) * ANIM_MAX_LEN;

            if (force || this.needSyncAfterSeek) {
                this.needSyncAfterSeek = false;
                this.anim.currentTime = targetTime;
                return;
            }

            // 计算音频底层进度与动画视觉进度的时钟漂移
            const currentAnimSec = (this.anim.currentTime / ANIM_MAX_LEN) * totalDuration;
            const drift = Math.abs(progress - currentAnimSec);

            // 只有当偏差超过阈值（如手动快进/点击歌词跳转/网络卡顿跳帧）才瞬时校准
            if (drift > DRIFT_THRESHOLD_SEC) {
                this.anim.currentTime = targetTime;
            }
        }

        play() {
            if (!this.isSeeking && this.anim.playState !== 'running') {
                this.anim.play();
            }
        }

        pause() {
            if (this.anim.playState !== 'paused') {
                this.anim.pause();
            }
        }

        setupEvents() {
            if (!this.elePrg) return;

            const updateFromPointer = (e) => {
                const rect = this.elePrg.getBoundingClientRect();
                if (rect.width > 0) {
                    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    this.anim.currentTime = ratio * ANIM_MAX_LEN;
                }
            };

            let dragging = false;

            const onPointerMove = (e) => {
                if (dragging) {
                    updateFromPointer(e);
                }
            };

            const onPointerUp = () => {
                if (dragging) {
                    dragging = false;
                    window.removeEventListener('pointermove', onPointerMove);
                    window.removeEventListener('pointerup', onPointerUp);
                    window.removeEventListener('pointercancel', onPointerUp);

                    this.needSyncAfterSeek = true;
                    setTimeout(() => {
                        this.isSeeking = false;
                        if (isPlaying && !document.hidden) {
                            this.play();
                        }
                    }, 50);
                }
            };

            this.elePrg.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                dragging = true;
                this.isSeeking = true;
                this.pause();
                updateFromPointer(e);

                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', onPointerUp);
                window.addEventListener('pointercancel', onPointerUp);
            });
        }

        destroy() {
            try {
                this.anim.cancel();
            } catch {}
        }
    }

    function cleanupDetached() {
        for (const controller of barControllers) {
            if (!document.contains(controller.eleHas)) {
                controller.destroy();
                barControllers.delete(controller);
            }
        }
    }

    function registerProgressBar(eleHas) {
        if (!eleHas) return;
        cleanupDetached();
        for (const c of barControllers) {
            if (c.eleHas === eleHas) return;
        }
        const controller = new ProgressBarController(eleHas);
        barControllers.add(controller);
    }

    // 全局单例监听音频播放器底层指令，杜绝重复监听
    legacyNativeCmder.appendRegisterCall('Load', 'audioplayer', (_, info) => {
        if (info && typeof info.duration === 'number' && info.duration > 0) {
            totalDuration = info.duration;
            currentProgress = 0;
            cleanupDetached();
            for (const c of barControllers) {
                c.syncRate(totalDuration);
                c.syncProgress(0, true);
                if (isPlaying && !document.hidden) {
                    c.play();
                }
            }
        }
    });

    legacyNativeCmder.appendRegisterCall('PlayProgress', 'audioplayer', (_, progress) => {
        if (typeof progress !== 'number' || progress < 0 || totalDuration <= 0) return;
        currentProgress = progress;
        cleanupDetached();
        for (const c of barControllers) {
            c.syncProgress(progress);
        }
    });

    legacyNativeCmder.appendRegisterCall('PlayState', 'audioplayer', (_, __, state) => {
        cleanupDetached();
        if (state === 1) {
            // 播放状态
            isPlaying = true;
            if (!document.hidden) {
                for (const c of barControllers) {
                    c.play();
                }
            }
        } else if (state === 2) {
            // 暂停状态
            isPlaying = false;
            for (const c of barControllers) {
                c.pause();
            }
        }
    });

    // 窗口最小化/遮挡自适应节能休眠
    document.addEventListener('visibilitychange', () => {
        cleanupDetached();
        if (document.hidden) {
            for (const c of barControllers) {
                c.pause();
            }
        } else {
            if (isPlaying && totalDuration > 0) {
                for (const c of barControllers) {
                    c.syncProgress(currentProgress, true);
                    c.play();
                }
            }
        }
    });

    // 挂载主界面与私人FM进度条
    betterncm.utils.waitForElement('#main-player .prg .has').then(registerProgressBar);
    betterncm.utils.waitForElement('.m-player-fm .prg .has').then(registerProgressBar);
});
