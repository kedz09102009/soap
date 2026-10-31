#!/usr/bin/env node
/**
 * Slidev overflow auditor.
 * Checks visible element boxes and text line boxes against the active slide canvas.
 * Uses the Google Chrome installation already present on the machine via Playwright.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

function getArg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const baseUrl = getArg('--url', 'http://localhost:3030').replace(/\/+$/, '')
const slideCount = Number.parseInt(getArg('--slides', '9'), 10)
const tolerance = Number.parseFloat(getArg('--tolerance', '2'))
const reportDir = path.resolve(getArg('--report-dir', 'reports'))

if (!Number.isInteger(slideCount) || slideCount < 1 || slideCount > 200) {
  console.error('Giá trị --slides phải là số nguyên từ 1 đến 200.')
  process.exit(1)
}
if (!Number.isFinite(tolerance) || tolerance < 0) {
  console.error('Giá trị --tolerance phải là số không âm.')
  process.exit(1)
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
})

const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
})

const results = []

try {
  for (let slideNumber = 1; slideNumber <= slideCount; slideNumber++) {
    const url = `${baseUrl}/${slideNumber}`
    process.stdout.write(`Đang kiểm tra slide ${slideNumber}/${slideCount}... `)

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

      // Slidev may keep outgoing and incoming slide elements in the DOM during
      // transitions. Wait for the element belonging to the requested slide,
      // not merely the first .slidev-page match (which may be hidden).
      await page.waitForFunction((expectedSlide) => {
        const pages = [...document.querySelectorAll('.slidev-page')]
        return pages.some((element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          const number = element.getAttribute('data-slidev-no')
          const matchesSlide = number == null || Number(number) === expectedSlide
          return matchesSlide
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0
        })
      }, slideNumber, { timeout: 30000 })

      await page.evaluate(async () => {
        if (document.fonts?.ready)
          await document.fonts.ready
        await Promise.all([...document.images].map(img => {
          if (img.complete)
            return Promise.resolve()
          return new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true })
            img.addEventListener('error', resolve, { once: true })
          })
        }))
      })
      // Let Vue transitions and layout settle before measuring.
      await page.waitForTimeout(500)

      const result = await page.evaluate(({ allowedTolerance, expectedSlide }) => {
        const pages = [...document.querySelectorAll('.slidev-page')]
        const isVisiblePage = (element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0
        }
        const visiblePages = pages.filter(isVisiblePage)
        const matchingPages = visiblePages.filter((element) => {
          const number = element.getAttribute('data-slidev-no')
          return number != null && Number(number) === expectedSlide
        })
        // Prefer the visible page explicitly numbered for this URL. Some Slidev
        // versions omit data-slidev-no; then use the largest visible page.
        const root = matchingPages.at(-1)
          || visiblePages.sort((a, b) => {
            const ar = a.getBoundingClientRect()
            const br = b.getBoundingClientRect()
            return (br.width * br.height) - (ar.width * ar.height)
          }).at(0)
        if (!root)
          return { error: `Không tìm thấy slide ${expectedSlide} đang hiển thị.` }

      const canvas = root.getBoundingClientRect()
      const logicalWidth = root.offsetWidth || canvas.width
      const logicalHeight = root.offsetHeight || canvas.height
      const scaleX = canvas.width / logicalWidth || 1
      const scaleY = canvas.height / logicalHeight || 1
      const clipValues = new Set(['hidden', 'clip', 'scroll', 'auto'])
      const issues = []

      const rectOutside = (rect, clip) => ({
        left: Math.max(0, clip.left - rect.left),
        right: Math.max(0, rect.right - clip.right),
        top: Math.max(0, clip.top - rect.top),
        bottom: Math.max(0, rect.bottom - clip.bottom),
      })

      function getEffectiveClip(element) {
        const clip = {
          left: canvas.left,
          top: canvas.top,
          right: canvas.right,
          bottom: canvas.bottom,
        }

        // Respect ancestors that intentionally clip their own contents.
        for (let ancestor = element.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor)
          const rect = ancestor.getBoundingClientRect()
          if (clipValues.has(style.overflowX)) {
            clip.left = Math.max(clip.left, rect.left)
            clip.right = Math.min(clip.right, rect.right)
          }
          if (clipValues.has(style.overflowY)) {
            clip.top = Math.max(clip.top, rect.top)
            clip.bottom = Math.min(clip.bottom, rect.bottom)
          }
        }
        return clip
      }

      function isVisible(element) {
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
          return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }

      function hasOverflowOk(element) {
        return Boolean(element.closest('[data-overflow-ok="true"], .ingredient-symbol'))
      }

      function describe(element) {
        const tag = element.tagName.toLowerCase()
        const classes = [...element.classList].slice(0, 3)
        const classText = classes.length ? `.${classes.join('.')}` : ''
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)
        return { selector: `${tag}${classText}`, text }
      }

      function addIssue(type, element, rect, clip, description = null) {
        const over = rectOutside(rect, clip)
        const edges = []
        if (over.left > allowedTolerance) edges.push(`trái ${Math.round(over.left / scaleX)}px`)
        if (over.right > allowedTolerance) edges.push(`phải ${Math.round(over.right / scaleX)}px`)
        if (over.top > allowedTolerance) edges.push(`trên ${Math.round(over.top / scaleY)}px`)
        if (over.bottom > allowedTolerance) edges.push(`dưới ${Math.round(over.bottom / scaleY)}px`)
        if (!edges.length)
          return
        const item = description || describe(element)
        issues.push({
          type,
          selector: item.selector,
          text: item.text,
          edges,
        })
      }

      // Check boxes such as cards, images, and positioned decorations.
      for (const element of root.querySelectorAll('*')) {
        if (!isVisible(element) || hasOverflowOk(element))
          continue
        const rect = element.getBoundingClientRect()
        const clip = getEffectiveClip(element)
        addIssue('ELEMENT_OUTSIDE', element, rect, clip)
      }

      // Check each rendered text line. This catches text that extends beyond the
      // slide canvas even when its containing box itself still fits.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (!node.nodeValue?.trim())
          continue
        const parent = node.parentElement
        if (!parent || hasOverflowOk(parent) || !isVisible(parent))
          continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const clip = getEffectiveClip(parent)
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0)
            continue
          addIssue('TEXT_OUTSIDE', parent, rect, clip, {
            ...describe(parent),
            text: node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 90),
          })
        }
      }

      // Remove repeated reports for the same selector, text, type, and edge set.
      const unique = new Map()
      for (const issue of issues) {
        const key = `${issue.type}|${issue.selector}|${issue.text}|${issue.edges.join(',')}`
        if (!unique.has(key))
          unique.set(key, issue)
      }

      return {
        title: document.title,
        canvas: {
          width: Math.round(logicalWidth),
          height: Math.round(logicalHeight),
        },
        issues: [...unique.values()],
      }
    }, { allowedTolerance: tolerance, expectedSlide: slideNumber })

    if (result.error) {
      results.push({ slide: slideNumber, status: 'ERROR', error: result.error, issues: [] })
      console.log('KHÔNG ĐỌC ĐƯỢC CANVAS')
      continue
    }

    const status = result.issues.length ? 'WARNING' : 'PASS'
    results.push({ slide: slideNumber, status, ...result })
    console.log(result.issues.length ? `CÓ ${result.issues.length} CẢNH BÁO` : 'ĐẠT')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ slide: slideNumber, status: 'ERROR', error: message, issues: [] })
      console.log('LỖI KIỂM TRA')
      console.error(`  ${message.split('\n')[0]}`)
    }
  }
}
finally {
  await browser.close()
}

await fs.mkdir(reportDir, { recursive: true })
const jsonPath = path.join(reportDir, 'slide-overflow-report.json')
await fs.writeFile(jsonPath, JSON.stringify({
  checkedAt: new Date().toISOString(),
  baseUrl,
  slideCount,
  toleranceLogicalPx: tolerance,
  results,
}, null, 2), 'utf8')

console.log('\n================ BÁO CÁO TRÀN NỘI DUNG ================')
for (const result of results) {
  console.log(`\nSlide ${result.slide}: ${result.status}`)
  if (result.error) {
    console.log(`  - ${result.error}`)
    continue
  }
  if (!result.issues.length) {
    console.log('  - Không phát hiện phần tử vượt khỏi vùng hiển thị.')
    continue
  }
  for (const issue of result.issues.slice(0, 20)) {
    console.log(`  - ${issue.selector}: ${issue.edges.join(', ')}`)
    if (issue.text)
      console.log(`    Nội dung: ${issue.text}`)
  }
  if (result.issues.length > 20)
    console.log(`  ... còn ${result.issues.length - 20} cảnh báo khác.`)
}

const warningCount = results.filter(item => item.status === 'WARNING').length
const errorCount = results.filter(item => item.status === 'ERROR').length
console.log(`\nTổng kết: ${results.length} slide | ${warningCount} slide có cảnh báo | ${errorCount} lỗi kiểm tra.`)
console.log(`Báo cáo JSON: ${jsonPath}`)
console.log('\nLưu ý: Đây là công cụ rà soát hình học ở trạng thái đang hiển thị. Hãy xem lại các cảnh báo trang trí có chủ ý và từng bước hiệu ứng khi bài có animation.')

if (warningCount > 0 || errorCount > 0)
  process.exitCode = 1
