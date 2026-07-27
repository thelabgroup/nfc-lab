/**
 * Form submission for the NFC Lab site.
 *
 * This site is a Webflow export. Webflow's bundled webflow.js binds a delegated
 * submit handler on `document` for every `.w-form form` and posts it to
 * https://webflow.com/api/v1/form/<site-id> — an endpoint that only accepts
 * submissions from Webflow-hosted domains. Self-hosted, every submission failed.
 *
 * This file takes those forms over. It listens on the CAPTURE phase at
 * `document`, which runs before jQuery's delegated (bubble-phase) handler can
 * see the event, and calls stopImmediatePropagation() so Webflow's handler
 * never runs. Only forms carrying `data-form` are intercepted, so the Finsweet
 * cookie-preferences forms keep working untouched.
 *
 * Markup contract (per form):
 *   data-form="<name>"        selects the server-side schema
 *   action="/api/forms/<name>" real endpoint, also used by the no-JS fallback
 *   method="post"
 *   input[name="_hp"]         honeypot, must stay empty
 *   [data-label]              human-readable label used in the notification email
 *   [data-value-from="#sel"]  hidden field populated from another element's text
 *
 * With JavaScript off the same markup still posts natively and the server
 * replies with a redirect, so the forms degrade rather than break.
 */
;(function () {
  'use strict'

  var ENDPOINT_TIMEOUT_MS = 20000
  var CONTACT_EMAIL = 'hello@thelabgroup.com'
  var loadedAt = Date.now()

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function wrapperFor(form) {
    return form.closest('.w-form') || form.parentElement
  }

  function stateEls(form) {
    var wrap = wrapperFor(form)
    return {
      done: wrap ? wrap.querySelector('.w-form-done') : null,
      fail: wrap ? wrap.querySelector('.w-form-fail') : null,
    }
  }

  function show(el) {
    if (el) el.style.display = 'block'
  }

  function hide(el) {
    if (el) el.style.display = 'none'
  }

  /** Human-readable label for a control, best source first. */
  function labelFor(el) {
    if (el.getAttribute('data-label')) return el.getAttribute('data-label')
    if (el.placeholder) return el.placeholder
    if (el.getAttribute('data-name')) return el.getAttribute('data-name')

    // An explicit <label for="..."> or a wrapping <label>.
    var byFor = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
    var wrapping = el.closest('label')
    var text = (byFor && byFor.textContent) || (wrapping && wrapping.textContent) || ''
    text = text.replace(/\s+/g, ' ').trim()
    if (text) return text

    // A select with a blank first option uses that option as its prompt.
    if (el.tagName === 'SELECT' && el.options.length && el.options[0].value === '') {
      return el.options[0].textContent.trim()
    }
    return el.name
  }

  var SKIP_TYPES = { submit: 1, button: 1, reset: 1, image: 1, file: 1 }

  /** Ordered, labelled field list — the shape the server renders emails from. */
  function collectFields(form) {
    var fields = []
    var elements = form.elements

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i]
      if (!el.name || el.disabled) continue
      if (el.name === '_hp') continue
      if (SKIP_TYPES[el.type]) continue

      var value
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (!el.checked) continue
        value = el.value === 'on' ? 'Yes' : el.value
      } else if (el.multiple && el.selectedOptions) {
        value = Array.prototype.map.call(el.selectedOptions, function (o) { return o.value }).join(', ')
      } else {
        value = el.value
      }

      if (value == null || String(value).trim() === '') continue
      fields.push({ name: el.name, label: labelFor(el), value: String(value).trim() })
    }
    return fields
  }

  /** Populate hidden fields that mirror text rendered elsewhere on the page. */
  function syncDerivedFields(form) {
    var derived = form.querySelectorAll('[data-value-from]')
    for (var i = 0; i < derived.length; i++) {
      var source = document.querySelector(derived[i].getAttribute('data-value-from'))
      derived[i].value = source ? source.textContent.replace(/\s+/g, ' ').trim() : ''
    }
  }

  function setButtonBusy(form, busy) {
    var btn = form.querySelector('[type="submit"]')
    if (!btn) return
    if (busy) {
      var waitText = btn.getAttribute('data-wait')
      if (waitText) {
        if (btn.tagName === 'INPUT') {
          if (!btn.hasAttribute('data-original-value')) {
            btn.setAttribute('data-original-value', btn.value)
          }
          btn.value = waitText
        } else {
          if (!btn.hasAttribute('data-original-value')) {
            btn.setAttribute('data-original-value', btn.textContent)
          }
          btn.textContent = waitText
        }
      }
      btn.disabled = true
    } else {
      var original = btn.getAttribute('data-original-value')
      if (original !== null) {
        if (btn.tagName === 'INPUT') btn.value = original
        else btn.textContent = original
      }
      btn.disabled = false
    }
  }

  function showFailure(form, message) {
    var els = stateEls(form)
    if (els.fail) {
      if (message) {
        var target = els.fail.firstElementChild || els.fail
        target.textContent = message
      }
      show(els.fail)
      els.fail.setAttribute('tabindex', '-1')
      els.fail.focus({ preventScroll: false })
    } else {
      window.alert(message || 'Something went wrong. Please try again.')
    }
  }

  function showSuccess(form) {
    var els = stateEls(form)
    hide(els.fail)
    form.style.display = 'none'
    show(els.done)
    if (els.done) {
      els.done.setAttribute('tabindex', '-1')
      els.done.focus({ preventScroll: false })
    }
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  var inFlight = new WeakSet()

  function submitForm(form) {
    if (inFlight.has(form)) return
    inFlight.add(form)

    var els = stateEls(form)
    hide(els.fail)
    hide(els.done)
    setButtonBusy(form, true)

    syncDerivedFields(form)

    var honeypot = form.querySelector('[name="_hp"]')
    var payload = {
      form: form.getAttribute('data-form'),
      page: window.location.href,
      _hp: honeypot ? honeypot.value : '',
      _t: Date.now() - loadedAt,
      fields: collectFields(form),
    }

    var controller = new AbortController()
    var timer = window.setTimeout(function () { controller.abort() }, ENDPOINT_TIMEOUT_MS)

    window
      .fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: 'same-origin',
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () { return {} })
          .then(function (body) { return { response: response, body: body } })
      })
      .then(function (result) {
        if (result.response.ok && result.body.ok !== false) {
          showSuccess(form)
          return
        }
        showFailure(
          form,
          result.body.error ||
            'Something went wrong while submitting the form. Please email ' + CONTACT_EMAIL + '.',
        )
      })
      .catch(function (err) {
        var message =
          err && err.name === 'AbortError'
            ? 'That took too long. Please check your connection and try again.'
            : 'We could not reach the server. Please try again, or email ' + CONTACT_EMAIL + '.'
        showFailure(form, message)
      })
      .then(function () {
        window.clearTimeout(timer)
        setButtonBusy(form, false)
        inFlight.delete(form)
      })
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  // Capture phase: runs before jQuery's delegated bubble-phase handler at
  // document, so stopImmediatePropagation() keeps webflow.js out of the way.
  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target
      if (!form || form.tagName !== 'FORM') return
      if (!form.hasAttribute('data-form')) return

      event.preventDefault()
      event.stopImmediatePropagation()

      // Let the browser surface its own validation UI first.
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        if (typeof form.reportValidity === 'function') form.reportValidity()
        return
      }

      submitForm(form)
    },
    true,
  )

  function init() {
    var forms = document.querySelectorAll('form[data-form]')
    for (var i = 0; i < forms.length; i++) {
      var els = stateEls(forms[i])
      // Announce state changes to screen readers when they appear.
      if (els.done) els.done.setAttribute('role', 'status')
      if (els.fail) els.fail.setAttribute('role', 'alert')
    }

    // The no-JavaScript path redirects back here on a delivery failure.
    if (forms.length && /[?&]error=1(&|$)/.test(window.location.search)) {
      showFailure(
        forms[0],
        'We could not deliver your message. Please try again, or email ' + CONTACT_EMAIL + '.',
      )
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
