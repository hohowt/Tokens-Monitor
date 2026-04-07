package main

import (
	"fmt"
	"os"
	"time"
)

func dumpData(vendor string, data []byte) {
	os.MkdirAll("D:\\Repos\\token-监控\\client\\test-dumps", 0755)
	path := fmt.Sprintf("D:\\Repos\\token-监控\\client\\test-dumps\\%d-%s.txt", time.Now().UnixNano(), vendor)
	os.WriteFile(path, data, 0644)
}
