package main

import (
	"fmt"
	"net"
)

// mitmPortMaxFallback 配置端口被占用时最多顺延尝试的端口个数（含首选端口本身计 1 次）。
const mitmPortMaxFallback = 64

// tryListenMitmPort 在 preferred 起依次尝试绑定 TCP 监听（与原先一致监听于 :port 即全部接口）。
// 返回监听器、实际端口号；全部失败时返回错误。
func tryListenMitmPort(preferred int) (net.Listener, int, error) {
	if preferred <= 0 || preferred > 65535 {
		preferred = 18090
	}
	for i := 0; i < mitmPortMaxFallback; i++ {
		port := preferred + i
		if port > 65535 {
			break
		}
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			return ln, port, nil
		}
	}
	return nil, 0, fmt.Errorf("无法在 %d–%d 范围内绑定可用端口（已尝试 %d 个）",
		preferred, min(preferred+mitmPortMaxFallback-1, 65535), mitmPortMaxFallback)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
