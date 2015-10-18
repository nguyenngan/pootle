/*
 * Copyright (C) Pootle contributors.
 *
 * This file is a part of the Pootle project. It is distributed under the GPL3
 * or later license. See the LICENSE file for a copy of the license and the
 * AUTHORS file for copyright and authorship information.
 */

import $ from 'jquery';
import _ from 'underscore';

// jQuery plugins
import 'jquery-caret';
import 'jquery-cookie';
import 'jquery-easing';
import 'jquery-highlightRegex';
import 'jquery-history';
import 'jquery-jsonp';
import 'jquery-serializeObject';
import 'jquery-utils';

// Other plugins
import autosize from 'autosize';
// XXX: this weirdness is temporarily needed because the version of
// diff-match-patch we bundle is not CommonJS-friendly
require('imports?this=>window!diff-match-patch');
import 'iso8601';
import Levenshtein from 'levenshtein';
import assign from 'object-assign';
import 'shortcut';

import fetch from 'utils/fetch';
import linkHashtags from 'utils/linkHashtags';

import captcha from '../captcha';
import { UnitSet } from '../collections';
import helpers from '../helpers';
import msg from '../msg';
import score from '../score';
import search from '../search';
import utils from '../utils';
import {
  escapeUnsafeRegexSymbols, makeRegexForMultipleWords, normalizeCode
} from './utils';


const CTX_STEP = 1;


const filterSelectOpts = {
  dropdownAutoWidth: true,
  width: 'off'
};
const sortSelectOpts = assign({
  minimumResultsForSearch: -1
}, filterSelectOpts);


let mtBackends = [];


function _refreshChecksSnippet(newChecks) {
  const $checks = $('.js-unit-checks');
  const focusedArea = $('.focusthis')[0];

  $checks.html(newChecks).show();
  utils.blinkClass($checks, 'blink', 4, 200);
  focusedArea.focus();
}


window.PTL = window.PTL || {};


PTL.editor = {

  /* Initializes the editor */
  init: function (options) {

    /* Default settings */
    this.settings = {
      mt: []
    };

    options && assign(this.settings, options);

    /* Initialize variables */
    this.units = new UnitSet([], {
      chunkSize: this.settings.chunkSize
    });

    this.filter = 'all';
    this.checks = [];
    this.sortBy = 'default';
    this.modifiedSince = null;
    this.user = null;
    this.ctxGap = 0;
    this.ctxQty = parseInt($.cookie('ctxQty'), 10) || 1;
    this.preventNavigation = false;

    this.isUnitDirty = false;

    this.isLoading = true;
    this.showActivity();

    /* Regular expressions */
    this.cpRE = /^(<[^>]+>|\[n\|t]|\W$^\n)*(\b|$)/gm;

    /* TM requests handler */
    this.tmReq = null;

    /* Differencer */
    this.differencer = new diff_match_patch();
    /* Levenshtein word comparer */
    this.wordComparer = new Levenshtein({compare: 'words'});

    /* Compile templates */
    this.tmpl = {
      vUnit: _.template($('#view_unit').html()),
      tm: _.template($('#tm_suggestions').html()),
      editCtx: _.template($('#editCtx').html()),
      msg: _.template($('#js-editor-msg').html()),
    };

    /* Initialize search */
    search.init({
      onSearch: this.onSearch
    });

    /* Select2 */
    $('#js-filter-status').select2(filterSelectOpts);
    $('#js-filter-sort').select2(sortSelectOpts);

    /* Screenshot images */
    $(document).on('click', '.js-dev-img', function (e) {
      e.preventDefault();

      $(this).magnificPopup({
        type: 'image',
        gallery: {
          enabled: true
        }
      }).magnificPopup('open');
    });

    /*
     * Bind event handlers
     */

    /* State changes */
    $(document).on('input', '.js-translation-area',
                   (e) => this.onTextareaChange(e));
    $(document).on('change', 'input.fuzzycheck',
                   () => this.onStateChange());
    $(document).on('click', 'input.fuzzycheck',
                   () => this.onStateClick());
    $(document).on('input', '#id_translator_comment',
                   () => this.handleTranslationChange());

    /* Suggest / submit */
    $(document).on('click', '.switch-suggest-mode a',
                   (e) => this.toggleSuggestMode(e));

    /* Update focus when appropriate */
    $(document).on('focus', '.focusthis', function (e) {
      PTL.editor.focused = e.target;
    });

    /* General */
    $(document).on('click', '.js-editor-reload', function (e) {
      e.preventDefault();
      $.history.load('');
    });

    /* Write TM results, special chars... into the currently focused element */
    $(document).on('click', '.js-editor-copytext', (e) => this.copyText(e));

    /* Copy translator comment */
    $(document).on('click', '.js-editor-copy-comment', (e) => {
      const text = e.currentTarget.dataset.string;
      this.copyComment(text);
    });

    /* Copy original translation */
    $(document).on('click', '.js-copyoriginal', (e) => {
      const uId = e.currentTarget.dataset.uid;
      const sources = [
        ...document.querySelectorAll(`#js-unit-${uId} .translation-text`)
      ].map((el) => el.textContent);
      this.copyOriginal(sources);
    });

    /* Editor navigation/submission */
    $(document).on('mouseup', 'tr.view-row, tr.ctx-row', this.gotoUnit);
    $(document).on('keypress', '.js-unit-index', (e) => this.gotoIndex(e));
    $(document).on('dblclick click', '.js-unit-index', this.unitIndex);
    $(document).on('click', 'input.submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });
    $(document).on('click', 'input.suggest', (e) => {
      e.preventDefault();
      this.handleSuggest();
    });
    $(document).on('click', '#js-nav-prev', () => this.gotoPrev());
    $(document).on('click', '#js-nav-next', () => this.gotoNext());
    $(document).on('click', '.js-suggestion-reject', this.rejectSuggestion);
    $(document).on('click', '.js-suggestion-accept', this.acceptSuggestion);
    $(document).on('click', '#js-toggle-timeline', this.toggleTimeline);
    $(document).on('click', '.js-toggle-check', this.toggleCheck);

    /* Filtering */
    $(document).on('change', '#js-filter-status', () => this.filterStatus());
    $(document).on('change', '#js-filter-checks', () => this.filterChecks());
    $(document).on('change', '#js-filter-sort', () => this.filterSort());
    $(document).on('click', '.js-more-ctx', () => this.moreContext());
    $(document).on('click', '.js-less-ctx', () => this.lessContext());
    $(document).on('click', '.js-show-ctx', () => this.showContext());
    $(document).on('click', '.js-hide-ctx', () => this.hideContext());

    /* Commenting */
    $(document).on('click', '.js-editor-comment', function (e) {
      e.preventDefault();
      const $elem = $('.js-editor-comment-form');
      const $comment = $('.js-editor-comment');
      $comment.toggleClass('selected');
      if ($comment.hasClass('selected')) {
        $elem.css('display', 'inline-block');
        $('#id_translator_comment').focus();
      } else {
        $elem.css('display', 'none');
      }
    });
    $(document).on('submit', '#js-comment-form', this.comment);
    $(document).on('click', '.js-comment-remove', this.removeComment);

    /* Misc */
    $(document).on('click', '.js-editor-msg-hide', this.hideMsg);

    $(document).on('click', '.js-toggle-raw', function (e) {
      e.preventDefault();
      $('.js-translate-translation').toggleClass('raw');
      $('.js-toggle-raw').toggleClass('selected');
      autosize.update(document.querySelector('.js-translation-area'));
    });

    /* Confirmation prompt */
    window.addEventListener('beforeunload', (e) => {
      if (PTL.editor.isUnitDirty) {
        e.returnValue = gettext(
          'You have unsaved changes in this string. Navigating away will discard those changes.'
        );
      }
    });

    /* Bind hotkeys */
    shortcut.add('ctrl+return', () => {
      if (this.isSuggestMode()) {
        this.handleSuggest();
      } else {
        this.handleSubmit();
      }
    });
    shortcut.add('ctrl+space', () => this.toggleState());
    shortcut.add('ctrl+shift+space', (e) => this.toggleSuggestMode(e));

    shortcut.add('ctrl+up', () => this.gotoPrev());
    shortcut.add('ctrl+,', () => this.gotoPrev());

    shortcut.add('ctrl+down', () => this.gotoNext({isSubmission: false}));
    shortcut.add('ctrl+.', () => this.gotoNext({isSubmission: false}));

    if (navigator.platform.toUpperCase().indexOf('MAC') >= 0) {
      // Optimize string join with '<br/>' as separator
      $('#js-nav-next')
        .attr('title',
              gettext('Go to the next string (Ctrl+.)<br/><br/>Also:<br/>Next page: Ctrl+Shift+.<br/>Last page: Ctrl+Shift+End')
      );
      $('#js-nav-prev')
        .attr('title',
              gettext('Go to the previous string (Ctrl+,)<br/><br/>Also:</br>Previous page: Ctrl+Shift+,<br/>First page: Ctrl+Shift+Home')
      );
    }

    shortcut.add('ctrl+shift+n', this.unitIndex);

    /* XHR activity indicator */
    $(document).ajaxStart(() => {
      clearTimeout(this.delayedActivityTimer);
      this.delayedActivityTimer = setTimeout(() => {
        this.showActivity();
      }, 3000);
    });
    $(document).ajaxStop(() => {
      clearTimeout(this.delayedActivityTimer);
      if (!this.isLoading) {
        this.hideActivity();
      }
    });

    /* Load MT backends */
    this.settings.mt.forEach((backend) => {
      require.ensure([], () => {
        module = require('./mt/' + backend.name);
        module.init(backend.key);
        mtBackends.push(module);
      });
    });

    // Update relative dates every minute
    setInterval(helpers.updateRelativeDates, 6e4);

    /* History support */
    $.history.init((hash) => {
      var params = utils.getParsedHash(hash),
          isInitial = true,
          uId = 0;

      // Walk through known filtering criterias and apply them to the editor object

      if (params.unit) {
        var uIdParam = parseInt(params.unit, 10);

        if (uIdParam && !isNaN(uIdParam)) {
          var current = this.units.getCurrent(),
              newUnit = this.units.get(uIdParam);
          if (newUnit && newUnit !== current) {
            this.units.setCurrent(newUnit);
            this.displayEditUnit();
            return;
          } else {
            uId = uIdParam;
            // Don't retrieve initial data if there are existing results
            isInitial = !this.units.length;
          }
        }
      }

      // Reset to defaults
      this.filter = 'all';
      this.checks = [];
      this.category = [];
      this.sortBy = 'default';

      if ('filter' in params) {
        var filterName = params.filter;

        // Set current state
        this.filter = filterName;

        if (filterName === 'checks' && 'checks' in params) {
          this.checks = params.checks.split(',');
        }
        if (filterName === 'checks' && 'category' in params) {
          this.category = params.category;
        }
        if ('sort' in params) {
          this.sortBy = params.sort;
        }
      }

      if ('modified-since' in params) {
        this.modifiedSince = params['modified-since'];
      } else {
        this.modifiedSince = null;
      }

      if ('month' in params) {
        this.month = params.month;
      } else {
        this.month = null;
      }

      // Only accept the user parameter for 'user-*' filters
      if ('user' in params && this.filter.indexOf('user-') === 0) {
        var user;
        this.user = user = encodeURIComponent(params.user);

        var newOpts = [],
            values = {
          'user-suggestions':
            // Translators: '%s' is a username
            interpolate(gettext("%s's pending suggestions"), [user]),
          'user-suggestions-accepted':
            // Translators: '%s' is a username
            interpolate(gettext("%s's accepted suggestions"), [user]),
          'user-suggestions-rejected':
            // Translators: '%s' is a username
            interpolate(gettext("%s's rejected suggestions"), [user]),
          'user-submissions':
            // Translators: '%s' is a username
            interpolate(gettext("%s's submissions"), [user]),
          'user-submissions-overwritten':
            // Translators: '%s' is a username, meaning "submissions by %s,
            // that were overwritten"
            interpolate(gettext("%s's overwritten submissions"), [user]),
        };
        for (var key in values) {
          newOpts.push([
            '<option value="', key, '" data-user="', user, '" class="',
            'js-user-filter' ,'">', values[key], '</option>'
          ].join(''));
        }
        $(".js-user-filter").remove();
        $('#js-filter-status').append(newOpts.join(''));
      }

      if ('search' in params) {
        // Note that currently the search, if provided along with the other
        // filters, would override them
        this.filter = 'search';

        let newState = {
          searchText: params.search,
        };

        if ('sfields' in params) {
          newState.searchFields = params.sfields.split(',');
        }
        if ('soptions' in params) {
          newState.searchOptions = params.soptions.split(',');
        }

        search.setState(newState);
      }

      // Update the filter UI to match the current filter

      // disable navigation on UI toolbar events to prevent data reload
      this.preventNavigation = true;

      var filterValue = this.filter === 'search' ? 'all' : this.filter;
      $('#js-filter-status').select2('val', filterValue);

      if (this.filter === 'checks') {
        // if the checks selector is empty (i.e. the 'change' event was not fired
        // because the selection did not change), force the update to populate the selector
        if ($('#js-filter-checks').is(':hidden')) {
          this.getCheckOptions()
              .then((data) => this.appendChecks(data),
                    this.error);
        }
      }

      $('#js-filter-sort').select2('val', this.sortBy);

      if (this.filter === 'search') {
        $('.js-filter-checks-wrapper').hide();
      }

      // re-enable normal event handling
      this.preventNavigation = false;

      this.fetchUnits({
        initial: isInitial,
        uId: uId,
      }).then((hasResults) => {
        if (!hasResults) {
          return;
        }

        if (uId > 0) {
          this.units.setCurrent(uId);
        } else {
          this.units.setFirstAsCurrent();
        }
        this.displayEditUnit();
      });

    }, {'unescape': true});

  },

  /* Stuff to be done when the editor is ready  */
  ready: function () {
    var currentUnit = this.units.getCurrent();
    if (currentUnit.get('isObsolete')) {
      this.displayObsoleteMsg();
    }

    autosize(document.querySelector('textarea.expanding'));

    // set direction of the comment body
    $('.extra-item-comment').filter(':not([dir])').bidi();
    // set direction of the suggestion body
    $('.suggestion-translation-body').filter(':not([dir])').bidi();

    // Focus on the first textarea, if any
    var firstArea = $('.focusthis')[0];
    if (firstArea) {
      firstArea.focus();
    }

    this.settings.targetLang = normalizeCode(
      $('.js-translation-area').attr('lang')
    );

    const $devComments = $('.js-developer-comments');
    $devComments.html(linkHashtags($devComments.html()));

    if (this.filter === 'search') {
      this.hlSearch();
    }

    if (this.settings.tmUrl !== '') {
      this.getTMUnits();
    }

    if (this.tmData !== null) {
      var tmContent = this.getTMUnitsContent(this.tmData);
      $('#extras-container').append(tmContent);
    }

    // All is ready, let's call the ready functions of the MT backends
    mtBackends.forEach((backend) => backend.ready());

    this.isUnitDirty = false;
    this.keepState = false;
    this.isLoading = false;
    this.hideActivity();
    this.updateExportLink();
    helpers.updateRelativeDates();
  },

  /* Things to do when no results are returned */
  noResults: function () {
    this.displayMsg({body: gettext("No results.")});
    this.reDraw();
  },

  canNavigate: function() {
    if (this.isUnitDirty) {
      return window.confirm(
        gettext(
          'You have unsaved changes in this string. Navigating away will discard those changes.'
        )
      );
    }

    return true;
  },


  /*
   * Text utils
   */

  /* Highlights search results */
  hlSearch: function () {
    const { searchText, searchFields, searchOptions } = search.state;
    const selMap = {
      notes: 'div.developer-comments',
      locations: 'div.translate-locations',
      source: 'td.translate-original, div.original div.translation-text',
      target: 'td.translate-translation'
    };

    let sel = [];
    let hlRegex;

    // Build highlighting selector based on chosen search fields
    $.each(searchFields, function (i, field) {
      sel.push(`tr.edit-row ${selMap[field]}`);
      sel.push(`tr.view-row ${selMap[field]}`);
    });

    if (searchOptions.indexOf('exact') >= 0 ) {
      hlRegex = new RegExp([
          '(', escapeUnsafeRegexSymbols(searchText), ')'
        ].join(''));
    } else {
      hlRegex = new RegExp(makeRegexForMultipleWords(searchText), 'i');
    }
    $(sel.join(", ")).highlightRegex(hlRegex);
  },


  /* Copies text into the focused textarea */
  copyText: function (e) {
    var $el = $(e.currentTarget),
        action = $el.data('action'),
        text = $el.data('string') || $el.data('translation-aid') || $el.text(),
        $target = $(this.focused),
        start;

    if (action === "overwrite") {
      $target.val(text).trigger('input');
      start = text.length;
    } else {
      start = $target.caret().start + text.length;
      $target.val($target.caret().replace(text)).trigger('input');
    }

    $target.caret(start, start);
    autosize.update(this.focused);
  },


  /* Copies source text(s) into the target textarea(s)*/
  copyOriginal: function (sources) {
    var targets = $('.js-translation-area');
    if (targets.length) {
      var active,
          max = sources.length - 1;

      for (let i=0; i<targets.length; i++) {
        var newval = sources[i] || sources[max];
        $(targets.get(i)).val(newval).trigger('input');
      }

      // Focus on the first textarea
      active = $(targets)[0];
      active.focus();
      autosize.update(active);
      // Make this fuzzy
      PTL.editor.goFuzzy();
      // Place cursor at start of target text
      PTL.editor.cpRE.exec($(active).val());
      i = PTL.editor.cpRE.lastIndex;
      $(active).caret(i, i);
      PTL.editor.cpRE.lastIndex = 0;
    }
  },

  copyComment: function (text) {
    const comment = document.querySelector('.js-editor-comment');
    const commentForm = document.querySelector('.js-editor-comment-form');
    const commentInput = document.querySelector('#id_translator_comment');

    if (!comment.classList.contains('selected')) {
      commentForm.style.display = 'inline-block';
      comment.classList.add('selected');
    }

    commentInput.focus();
    commentInput.value = text;
  },


  /* Does the actual diffing */
  doDiff: function (a, b) {
    var html = [],
        diff = this.differencer.diff_main(a, b),
        op, text, i;

    this.differencer.diff_cleanupSemantic(diff);

    for (i=0; i<diff.length; i++) {
      op = diff[i][0];
      text = utils.fancyEscape(diff[i][1]);
      if (op === DIFF_INSERT) {
        html[i] = ['<span class="diff-insert">', text, '</span>'].join('');
      } else if (op === DIFF_DELETE) {
        html[i] = ['<span class="diff-delete">', text, '</span>'].join('');
      } else if (op === DIFF_EQUAL) {
        html[i] = text;
      }
    }

    return html.join('');
  },


  /*
   * Fuzzying / unfuzzying functions
   */

  /* Sets the current unit's styling as fuzzy */
  doFuzzyStyle: function () {
    $("tr.edit-row").addClass("fuzzy-unit");
  },


  /* Unsets the current unit's styling as fuzzy */
  undoFuzzyStyle: function () {
    $("tr.edit-row").removeClass("fuzzy-unit");
  },


  /* Checks the current unit's fuzzy checkbox */
  doFuzzyBox: function () {
    var $checkbox = $('input.fuzzycheck');
    $checkbox.prop('checked', true);

    if (!this.settings.isAdmin) {
      if (!PTL.editor.isSuggestMode()) {
        $('.js-fuzzy-block').show();
      }
      $checkbox[0].defaultChecked = true;
    }

    $checkbox.trigger('change');
  },


  /* Unchecks the current unit's fuzzy checkbox */
  undoFuzzyBox: function () {
    var $checkbox = $('input.fuzzycheck');
    $checkbox.prop('checked', false);
    $checkbox.trigger('change');
  },


  /* Sets the current unit status as fuzzy (both styling and checkbox) */
  goFuzzy: function () {
    if (!this.isFuzzy()) {
      this.doFuzzyStyle();
      this.doFuzzyBox();
    }
  },


  /* Unsets the current unit status as fuzzy (both styling and checkbox) */
  ungoFuzzy: function () {
    if (this.isFuzzy()) {
      this.undoFuzzyStyle();
      this.undoFuzzyBox();
    }
  },


  /* Returns whether the current unit is fuzzy or not */
  isFuzzy: function () {
    return $('input.fuzzycheck').prop('checked');
  },

  toggleFuzzyStyle: function () {
    if (this.isFuzzy()) {
      this.doFuzzyStyle();
    } else {
      this.undoFuzzyStyle();
    }
  },

  toggleState: function () {
    // `blur()` prevents a double-click effect if the checkbox was
    // previously clicked using the mouse
    $('input.fuzzycheck').blur().click();
  },

  /* Updates unit textarea and input's `default*` values. */
  updateUnitDefaultProperties: function () {
    $('.js-translation-area').each(function () {
      this.defaultValue = this.value;
    });
    var checkbox = $('#id_state')[0];
    checkbox.defaultChecked = checkbox.checked;
    this.handleTranslationChange();
  },

  /* Updates comment area's `defaultValue` value. */
  updateCommentDefaultProperties: function () {
    const comment = document.querySelector('#id_translator_comment');
    comment.defaultValue = comment.value;
    this.handleTranslationChange();
  },

  handleTranslationChange: function () {
    const comment = document.querySelector('#id_translator_comment');
    const commentChanged = comment !== null ?
                           comment.value !== comment.defaultValue : false;

    var submit = $('.js-submit')[0],
        suggest = $('.js-suggest')[0],
        translations = $('.js-translation-area').get(),
        suggestions = $('.js-user-suggestion').map(function () {
            return $(this).data('translation-aid');
          }).get(),
        checkbox = $('#id_state')[0],
        stateChanged = checkbox.defaultChecked !== checkbox.checked,
        areaChanged = false,
        needsReview = false,
        suggestionExists = false,
        area, i;

    // Non-admin users are required to clear the fuzzy checkbox
    if (!this.settings.isAdmin) {
      needsReview = checkbox.checked === true;
    }

    for (i=0; i<translations.length && !areaChanged; i++) {
      area = translations[i];
      areaChanged = area.defaultValue !== area.value;
    }

    if (suggestions.length) {
      for (i=0; i<translations.length && !suggestionExists; i++) {
        area = translations[i];
        suggestionExists = suggestions.indexOf(area.value) !== -1;
      }
    }

    // Store dirty state for the current unit
    this.isUnitDirty = areaChanged || stateChanged || commentChanged;

    if (submit !== undefined) {
      submit.disabled = !(stateChanged || areaChanged) || needsReview;
    }
    if (suggest !== undefined) {
      suggest.disabled = !areaChanged || suggestionExists;
    }
  },

  onStateChange: function () {
    this.handleTranslationChange();

    this.toggleFuzzyStyle();
  },

  onStateClick: function () {
    // Prevent automatic unfuzzying on explicit user action
    this.keepState = true;
  },

  onTextareaChange: function (e) {
    this.handleTranslationChange();

    var that = this,
        el = e.target,
        hasChanged = el.defaultValue !== el.value;

    if (hasChanged && !this.keepState) {
      this.ungoFuzzy();
    }

    clearTimeout(this.similarityTimer);
    this.similarityTimer = setTimeout(function () {
      that.checkSimilarTranslations();
      that.similarityTimer = null;  // So we know the code was run
    }, 200);
  },


  /*
   * Translation's similarity
   */

  getSimilarityData: function () {
    var currentUnit = this.units.getCurrent();
    return {
      similarity: currentUnit.get('similarityHuman'),
      mt_similarity: currentUnit.get('similarityMT')
    };
  },

  calculateSimilarity: function (newTranslation, $elements, dataSelector) {
    var maxSimilarity = 0,
        boxId = null,
        $element, aidText, similarity, i;

    for (i=0; i<$elements.length; i++) {
      $element = $elements.eq(i);
      aidText = $element.data(dataSelector);
      similarity = this.wordComparer.similarity(newTranslation, aidText);

      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        boxId = $element.hasClass('js-translation-area') ?
                null : $element.val('id');
      }
    }

    return {
      max: maxSimilarity,
      boxId: boxId
    };
  },

  checkSimilarTranslations: function () {
    var dataSelector = 'translation-aid',
        dataSelectorMT = 'translation-aid-mt',
        $aidElementsMT = $(['[data-', dataSelectorMT, ']'].join(''));

    let aidElementsSelector = `[data-${dataSelector}]`;

    // Exclude own suggestions for non-anonymous users
    if (!this.settings.isAnonymous) {
      aidElementsSelector += `[data-suggestor-id!=${this.settings.userId}]`;
    }

    const $aidElements = $(aidElementsSelector);

    if (!$aidElements.length && !$aidElementsMT.length) {
      return false;
    }

    var currentUnit = this.units.getCurrent(),
        newTranslation = $('.js-translation-area').val(),
        simHuman = {max: 0, boxId: null},
        simMT = {max: 0, boxId: null},
        similarity;

    if ($aidElements.length) {
      simHuman = this.calculateSimilarity(newTranslation, $aidElements,
                                          dataSelector);
    }
    if ($aidElementsMT.length) {
      simMT = this.calculateSimilarity(newTranslation, $aidElementsMT,
                                       dataSelectorMT);
    }

    currentUnit.set({
      similarityHuman: simHuman.max,
      similarityMT: simMT.max
    });

    similarity = (simHuman.max > simMT.max) ? simHuman : simMT;
    this.highlightBox(similarity.boxId, similarity.max === 1);
  },

  /* Applies highlight classes to `boxId`. */
  highlightBox: function (boxId, isExact) {
    var bestMatchCls = 'best-match',
        exactMatchCls = 'exact-match';

    $('.translate-table').find(['.', bestMatchCls].join(''))
                         .removeClass([bestMatchCls, exactMatchCls].join(' '));

    if (boxId === null) {
      return false;
    }

    var hlClasses = [bestMatchCls];
    isExact && hlClasses.push(exactMatchCls);
    $(boxId).addClass(hlClasses.join(' '));
  },


  /*
   * Suggest / submit mode functions
   */

  /* Changes the editor into suggest mode */
  doSuggestMode: function () {
    $("table.translate-table").addClass("suggest-mode");
  },


  /* Changes the editor into submit mode */
  undoSuggestMode: function () {
    $("table.translate-table").removeClass("suggest-mode");
  },


  /* Returns true if the editor is in suggest mode */
  isSuggestMode: function () {
    return $("table.translate-table").hasClass("suggest-mode");
  },


  /* Toggles suggest/submit modes */
  toggleSuggestMode: function (e) {
    e.preventDefault();
    if (this.isSuggestMode()) {
      this.undoSuggestMode();
    } else {
      this.doSuggestMode();
    }
  },

  updateExportLink: function () {
    var $exportOpt = $('.js-export-view'),
        baseUrl = $exportOpt.data('export-url'),
        hash = utils.getHash().replace(/&?unit=\d+/, ''),
        exportLink = hash ? [baseUrl, hash].join('?') : baseUrl;

    $exportOpt.data('href', exportLink);
  },

  /*
   * Indicators, messages, error handling
   */

  showActivity: function (force) {
    this.hideMsg();
    $("#js-editor-act").spin().fadeIn(300);
  },

  hideActivity: function () {
    $("#js-editor-act").spin(false).fadeOut(300);
  },

  /* Displays an informative message */
  displayMsg: function ({ showClose=true, body=null }) {
    this.hideActivity();
    helpers.fixSidebarHeight();
    $('#js-editor-msg-overlay').html(
      this.tmpl.msg({ showClose, body })
    ).fadeIn(300);
  },

  hideMsg: function () {
    var $wrapper = $('#js-editor-msg-overlay');
    $wrapper.length && $wrapper.fadeOut(300);
  },

  /* Displays error messages on top of the toolbar */
  displayError: function (text) {
    this.hideActivity();
    msg.show({text: text, level: 'error'});
  },


  /* Handles XHR errors */
  error: function (xhr, s) {
    var msg = "";

    if (s === "abort") {
        return;
    }

    if (xhr.status === 0) {
      msg = gettext("Error while connecting to the server");
    } else if (xhr.status === 402) {
      captcha.onError(xhr, 'PTL.editor.error');
    } else if (xhr.status === 404) {
      msg = gettext("Not found");
    } else if (xhr.status === 500) {
      msg = gettext("Server error");
    } else if (s === 'timeout') {
      msg = gettext("The server seems down. Try again later.");
    } else {
      // Since we use jquery-jsonp, we must differentiate between
      // the passed arguments
      if (xhr.hasOwnProperty('responseText')) {
        msg = $.parseJSON(xhr.responseText).msg;
      } else {
        msg = gettext("Unknown error");
      }
    }

    PTL.editor.displayError(msg);
  },

  displayObsoleteMsg: function () {
    var msgText = gettext('This string no longer exists.'),
        backMsg = gettext('Go back to browsing'),
        backLink = $('.js-back-to-browser').attr('href'),
        reloadMsg = gettext('Reload page'),
        html = [
          '<div>', msgText, '</div>',
          '<div class="editor-msg-btns">',
            '<a class="btn btn-xs js-editor-reload" href="#">', reloadMsg, '</a>',
            '<a class="btn btn-xs" href="', backLink, '">', backMsg, '</a>',

          '</div>',
        ].join('');

    PTL.editor.displayMsg({body: html, showClose: false});
  },


  /*
   * Misc functions
   */

  /* Gets common request data */
  getReqData: function () {
    var reqData = {};

    if (this.filter === 'checks' && this.checks.length) {
      reqData.checks = this.checks.join(",");
    }
    if (this.filter === 'checks' && this.category.length) {
      reqData.category = this.category;
    }


    if (this.filter === 'search') {
      let {searchText, searchFields, searchOptions} = search.state;
      reqData.search = searchText;
      reqData.sfields = searchFields;
      reqData.soptions = searchOptions;
    } else {
      reqData.filter = this.filter;
      this.sortBy !== 'default' && (reqData.sort = this.sortBy);
    }

    if (this.modifiedSince !== null) {
      reqData['modified-since'] = this.modifiedSince;
    }

    if (this.user) {
      reqData.user = this.user;
    }

    return reqData;
  },


  /*
   * Unit navigation, display, submission
   */


  /* Renders a single row */
  renderRow: function (unit) {
    return (
      `<tr id="row${unit.id}" class="view-row">` +
        this.tmpl.vUnit({unit: unit.toJSON()}) +
      '</tr>'
    );
  },

  /* Renders the editor rows */
  renderRows: function () {
    const unitGroups = this.getUnitGroups();
    const currentUnit = this.units.getCurrent();

    let rows = [];

    unitGroups.forEach((unitGroup) => {
      // Don't display a delimiter row if all units have the same origin
      if (unitGroups.length !== 1) {
        rows.push(
          '<tr class="delimiter-row"><td colspan="2">' +
            `<div class="hd"><h2>${unitGroup.path}</h2></div>` +
          '</td></tr>'
        );
      }

      for (let i=0; i<unitGroup.units.length; i++) {
        let unit = unitGroup.units[i];

        if (unit.id === currentUnit.id) {
          rows.push(this.getEditUnit());
        } else {
          rows.push(this.renderRow(unit));
        }
      }
    });

    return rows.join('');
  },


  /* Renders context rows for units passed as 'units' */
  renderCtxRows: function (units, extraCls) {
    const currentUnit = this.units.getCurrent();
    let rows = '';

    for (let i=0; i<units.length; i++) {
      // FIXME: Please let's use proper models for context units
      let unit = units[i];
      unit = assign({}, currentUnit.toJSON(), unit);

      rows += `<tr id="ctx${unit.id}" class="ctx-row ${extraCls}">`;
      rows += this.tmpl.vUnit({unit: unit});
      rows += '</tr>';
    }

    return rows;
  },


  /* Returns the unit groups for the current editor state */
  getUnitGroups: function () {
    var limit = parseInt(((this.units.chunkSize - 1) / 2), 10),
        unitCount = this.units.length,
        currentUnit = this.units.getCurrent(),
        curIndex = this.units.indexOf(currentUnit),
        begin = curIndex - limit,
        end = curIndex + 1 + limit,
        prevPath = null,
        pootlePath;

    if (begin < 0) {
      end = end + -begin;
      begin = 0;
    } else if (end > unitCount) {
      if (begin > end - unitCount) {
        begin = begin + -(end - unitCount);
      } else {
        begin = 0;
      }
      end = unitCount;
    }

    return _.reduce(this.units.slice(begin, end), function (out, unit) {
      pootlePath = unit.get('store').get('pootlePath');

      if (pootlePath === prevPath) {
        out[out.length-1].units.push(unit);
      } else {
        out.push({
          path: pootlePath,
          units: [unit]
        });
      }

      prevPath = pootlePath;

      return out;
    }, []);
  },


  /* Sets the edit view for the current active unit */
  displayEditUnit: function () {
    if (this.units.length) {
      this.fetchUnits();

      this.hideMsg();

      this.reDraw(this.renderRows());

      this.updateNavButtons();
    }
  },


  /* reDraws the translate table rows */
  reDraw: function (newTbody) {
    const $where = $('.js-editor-body');
    const $oldRows = $where.find('tr');

    $oldRows.remove();

    if (newTbody !== undefined) {
      $where.append(newTbody);

      this.ready();
    }
  },


  /* Updates a button in `selector` to the `disable` state */
  updateNavButton: function (selector, disable) {
    var $el = $(selector);

    // Avoid unnecessary actions
    if ($el.is(':disabled') && disable || $el.is(':enabled') && !disable) {
      return;
    }

    if (disable) {
      $el.data('title', $el.attr('title'));
      $el.removeAttr('title');
    } else {
      $el.attr('title', $el.data('title'));
    }
    $el.prop('disabled', disable);
  },


  /* Updates previous/next navigation button states */
  updateNavButtons: function () {
    this.updateNavButton('#js-nav-prev', !this.units.hasPrev());
    this.updateNavButton('#js-nav-next', !this.units.hasNext());
  },


  /* Fetches more units in case they are needed */
  fetchUnits: function ({ initial=false, uId=0 } = {}) {
    let reqData = {
      path: this.settings.pootlePath,
    };

    if (initial) {
      reqData.initial = initial;

      if (uId > 0) {
        reqData.uids = uId;
      }
    } else {
      // Only fetch units limited to an offset, and omit units that have
      // already been fetched
      const fetchedIds = this.units.fetchedIds();
      const offset = this.units.chunkSize;
      const curUId = uId > 0 ? uId : this.units.getCurrent().id;
      const uIndex = this.units.uIds.indexOf(curUId);

      let begin = Math.max(uIndex - offset, 0);
      let end = Math.min(uIndex + offset + 1, this.units.total);

      // Ensure we retrieve chunks of the right size
      if (uId === 0) {
        if (fetchedIds.indexOf(this.units.uIds[begin]) === -1) {
          begin = Math.max(begin - offset, 0);
        }
        if (fetchedIds.indexOf(this.units.uIds[end - 1]) === -1) {
          end = Math.min(end + offset + 1, this.units.total);
        }
      }

      let uIds = this.units.uIds.slice(begin, end);
      uIds = _.difference(uIds, fetchedIds);

      if (!uIds.length) {
        return;  // Nothing to be done
      }

      reqData.uids = uIds.join(',');
    }

    assign(reqData, this.getReqData());

    return $.ajax({
      url: l('/xhr/units/'),
      data: reqData,
      dataType: 'json',
      cache: false,
    }).then(
      (data) => this.storeUnitData(data),
      this.error
    );
  },

  storeUnitData: function (data) {
    if (data.uIds) {
      // Clear old data and add new results
      this.units.reset();

      this.units.uIds = data.uIds;
      this.units.total = data.uIds.length;
    }

    const { unitGroups } = data;
    if (!unitGroups.length) {
      this.noResults();
      return false;
    }

    for (let i=0; i<unitGroups.length; i++) {
      const unitGroup = unitGroups[i];
      for (let pootlePath in unitGroup) {
        const group = unitGroup[pootlePath];
        const store = assign({ pootlePath: pootlePath }, group.meta);
        const units = group.units.map((unit) => assign(unit, { store }));
        this.units.set(units, { remove: false });
      }
    }

    return true;
  },

  /* Updates the navigation controls */
  updateNav: function () {
    $("#items-count").text(this.units.total);

    var currentUnit = this.units.getCurrent();
    if (currentUnit !== undefined) {
      var uIndex = this.units.uIds.indexOf(currentUnit.id) + 1;
      $('.js-unit-index').text(uIndex);
    }

  },

  /* Loads the edit unit for the current active unit */
  getEditUnit: function () {
    let eClass = 'edit-row';
    let currentUnit = this.units.getCurrent();
    let widget = '';

    let reqData = {};
    this.settings.vFolder && (reqData.vfolder = this.settings.vFolder);

    $.ajax({
      url: l(`/xhr/units/${currentUnit.id}/edit/`),
      async: false,
      data: reqData,
      dataType: 'json',
      success: function (data) {
        PTL.editor.tmData = data.tm_suggestions || null;
        widget = data.editor;

        PTL.editor.updateNav();

        currentUnit.set('isObsolete', data.is_obsolete);
      },
      error: PTL.editor.error
    });

    eClass += currentUnit.get('isfuzzy') ? " fuzzy-unit" : "";
    eClass += PTL.editor.filter !== 'all' ? " with-ctx" : "";

    const [ctxRowBefore, ctxRowAfter] = this.renderCtxControls({ hasData: false });

    return (
      (PTL.editor.filter !== 'all' ? ctxRowBefore : '') +
      `<tr id="row${currentUnit.id}" class="${eClass}">` +
        widget +
      '</tr>' +
      (PTL.editor.filter !== 'all' ? ctxRowAfter : '')
    );
  },

  /* Pushes translation submissions and moves to the next unit */
  handleSubmit: function () {
    const el = document.querySelector('input.submit');
    const newTranslation = $('.js-translation-area')[0].value;
    const suggestions = $('.js-user-suggestion').map(function () {
      return {
        text: $(this).data('translation-aid'),
        id: this.id
      };
    }).get();
    const captchaCallbacks = {
      sfn: 'PTL.editor.processSubmission',
      efn: 'PTL.editor.error',
    };

    let body = $('#translate').serializeObject();

    this.updateUnitDefaultProperties();

    // Check if the string being submitted is already in the set of
    // suggestions
    // FIXME: this is LAME, I wanna die: we need to use proper models!!
    const suggestionIds = _.pluck(suggestions, 'id');
    const suggestionTexts = _.pluck(suggestions, 'text');
    const suggestionIndex = suggestionTexts.indexOf(newTranslation);

    if (suggestionIndex !== -1 && !this.isFuzzy()) {
      $(['#', suggestionIds[suggestionIndex]].join(''))
        .find('.js-suggestion-accept').trigger('click', [true]);
      return;
    }

    // If similarities were in the process of being calculated by the time
    // the submit button was clicked, clear the timer and calculate them
    // straight away
    if (this.similarityTimer !== null) {
      clearTimeout(this.similarityTimer);
      this.checkSimilarTranslations();
    }

    assign(body, this.getReqData(), this.getSimilarityData(), captchaCallbacks);

    el.disabled = true;

    fetch({
      body,
      url: `/xhr/units/${this.units.getCurrent().id}`,
      method: 'POST',
    }).then(
      (data) => this.processSubmission(data),
      this.error
    );
  },

  processSubmission: function (data) {
    // FIXME: handle this via events
    var translations = $('.js-translation-area').map(function (i, el) {
      return $(el).val();
    }).get();

    var unit = this.units.getCurrent();
    unit.setTranslation(translations);
    unit.set('isfuzzy', this.isFuzzy());

    let hasCriticalChecks = !!data.checks;
    $('.translate-container').toggleClass('error', hasCriticalChecks);

    if (data.user_score) {
      score.set(data.user_score);
    }

    if (hasCriticalChecks) {
      _refreshChecksSnippet(data.checks);
    } else {
      this.gotoNext();
    }
  },

  /* Pushes translation suggestions and moves to the next unit */
  handleSuggest: function () {
    const captchaCallbacks = {
      sfn: 'PTL.editor.processSuggestion',
      efn: 'PTL.editor.error'
    };

    let body = $('#translate').serializeObject();

    this.updateUnitDefaultProperties();

    // in suggest mode, do not send the fuzzy state flag
    // even if it is set in the form internally
    delete body.state;

    assign(body, this.getReqData(), this.getSimilarityData(), captchaCallbacks);

    fetch({
      body,
      url: `/xhr/units/${this.units.getCurrent().id}/suggestions/`,
      method: 'POST',
    }).then(
      (data) => this.processSuggestion(data),
      this.error
    );
  },

  processSuggestion: function (data) {
    if (data.user_score) {
      score.set(data.user_score);
    }

    this.gotoNext();
  },


  /* Loads the previous unit */
  gotoPrev: function () {
    if (!this.canNavigate()) {
      return false;
    }

    var newUnit = this.units.prev();
    if (newUnit) {
      var newHash = utils.updateHashPart('unit', newUnit.id);
      $.history.load(newHash);
    }
  },

  /* Loads the next unit */
  gotoNext: function (opts={isSubmission: true}) {
    if (!this.canNavigate()) {
      return false;
    }

    var newUnit = this.units.next();
    if (newUnit) {
      var newHash = utils.updateHashPart('unit', newUnit.id);
      $.history.load(newHash);
    } else if (opts.isSubmission) {
      var backLink = $('.js-back-to-browser').attr('href');
      window.location.href = [backLink, 'finished'].join('?');
    }
  },


  /* Loads the editor with a specific unit */
  gotoUnit: function (e) {
    e.preventDefault();

    if (!PTL.editor.canNavigate()) {
      return false;
    }

    // Ctrl + click / Alt + click / Cmd + click / Middle click opens a new tab
    if (e.ctrlKey || e.altKey || e.metaKey || e.which === 2) {
      var $el = e.target.nodeName !== 'TD' ?
                  $(e.target).parents('td') :
                  $(e.target);
      window.open($el.data('target'), '_blank');
      return;
    }

    // Don't load anything if we're just selecting text
    if (window.getSelection().toString() !== '') {
      return;
    }

    // Get clicked unit's uid from the row's id information and
    // try to load it
    var m = this.id.match(/(row|ctx)([0-9]+)/);
    if (m) {
      var newHash,
          type = m[1],
          uid = parseInt(m[2], 10);
      if (type === 'row') {
        newHash = utils.updateHashPart("unit", uid);
      } else {
        newHash = ['unit=', encodeURIComponent(uid)].join('');
      }
      $.history.load(newHash);
    }
  },

  /* Selects the element's contents and sets the focus */
  unitIndex: function (e) {
    e.preventDefault();

    var el = $('.js-unit-index')[0],
        selection = window.getSelection(),
        range = document.createRange();

    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    el.focus();
  },

  /* Loads the editor on a index */
  gotoIndex: function (e) {
    if (e.which === 13) { // Enter key
      e.preventDefault();
      var index = parseInt($('.js-unit-index').text(), 10);

      if (index && !isNaN(index) && index > 0 &&
          index <= this.units.total) {
        var uId = this.units.uIds[index-1],
            newHash = utils.updateHashPart('unit', uId);
        $.history.load(newHash);
      }
    }
  },

  /*
   * Units filtering
   */

  /* Gets the failing check options for the current query */
  getCheckOptions: function () {
    return (
      fetch({
        url: '/xhr/stats/checks/',
        body: {
          path: this.settings.pootlePath,
        },
      })
    );
  },

  /* Loads units based on checks filtering */
  filterChecks: function () {
    if (this.preventNavigation) {
      return;
    }
    if (!this.canNavigate()) {
      return false;
    }

    var filterChecks = $('#js-filter-checks').val();

    if (filterChecks !== 'none') {
      var sortBy = $('#js-filter-sort').val(),
          newHash = {
            filter: 'checks',
            checks: filterChecks
          };

      sortBy !== 'default' && (newHash.sort = sortBy);

      $.history.load($.param(newHash));
    }
  },

  /* Adds the failing checks to the UI */
  appendChecks: function (checks) {
    if (Object.keys(checks).length) {
      var $checks = $('#js-filter-checks'),
          selectedValue = this.checks[0] || 'none';

      $checks.find('optgroup').each(function (e) {
        var empty = true,
            $gr = $(this);

        $gr.find('option').each(function (e) {
          var $opt = $(this),
              value = $opt.val();

          if (value in checks) {
            empty = false;
            $opt.text($opt.data('title') + '(' + checks[value] + ')');
          } else {
            $opt.remove();
          }
        });

        if (empty) {
          $gr.hide();
        }
      });

      $checks.select2(filterSelectOpts).select2('val', selectedValue);
      $('.js-filter-checks-wrapper').css('display', 'inline-block');
    } else { // No results
      this.displayMsg({ body: gettext('No results.') });
      $('#js-filter-status').select2('val', PTL.editor.filter);
    }
  },

  filterSort: function () {
    const filterBy = $('#js-filter-status').val();
    // #104: Since multiple values can't be selected in the select
    // element, we also need to check for `this.checks`.
    const filterChecks = $('#js-filter-checks').val() || this.checks.join(',');
    const sortBy = $('#js-filter-sort').val();
    const user = this.user || null;

    let newHash = { filter: filterBy };

    if (this.category.length) {
      newHash.category = this.category;
    } else if (filterChecks !== 'none') {
      newHash.checks = filterChecks;
    }

    sortBy !== 'default' && (newHash.sort = sortBy);
    user !== null && (newHash.user = user);

    $.history.load($.param(newHash));
  },


  /* Loads units based on filtering */
  filterStatus: function () {
    if (!this.canNavigate()) {
      return false;
    }

    // this function can be executed in different contexts,
    // so using the full selector here
    var $selected = $('#js-filter-status option:selected'),
        filterBy = $selected.val(),
        isUserFilter = $selected.data('user'),
        $checksWrapper = $('.js-filter-checks-wrapper');

    if (filterBy === "checks") {
      this.getCheckOptions()
          .then((data) => this.appendChecks(data),
                this.error);
    } else { // Normal filtering options (untranslated, fuzzy...)
      $checksWrapper.hide();

      if (!this.preventNavigation) {
        var newHash = {filter: filterBy};

        if (this.user && isUserFilter) {
          newHash.user = this.user;
        } else {
          this.user = null;
          $(".js-user-filter").remove();

          this.sortBy !== 'default' && (newHash.sort = this.sortBy);
        }

        $.history.load($.param(newHash));
      }
    }
  },

  /* Generates the edit context rows' UI */
  renderCtxControls: function ({ hasData=false }) {
    const ctxRowBefore = this.tmpl.editCtx({
      hasData,
      extraCls: 'before'
    });
    const ctxRowAfter = this.tmpl.editCtx({
      hasData,
      extraCls: 'after'
    });

    return [ctxRowBefore, ctxRowAfter];
  },

  replaceCtxControls: function (ctx) {
    const [ctxRowBefore, ctxRowAfter] = ctx;

    $('tr.edit-ctx.before').replaceWith(ctxRowBefore);
    $('tr.edit-ctx.after').replaceWith(ctxRowAfter);
  },

  loadContext: function (unitId, amount) {
    return (
      fetch({
        url: `/xhr/units/${unitId}/context/`,
        body: {
          gap: this.ctxGap,
          qty: amount,
        },
      })
    );
  },

  handleContextSuccess: function (data) {
    if (!data.ctx.before.length && !data.ctx.after.length) {
      return undefined;
    }

    // As we now have got more context rows, increase its gap
    this.ctxGap += Math.max(data.ctx.before.length,
                            data.ctx.after.length);
    $.cookie('ctxQty', this.ctxGap, {path: '/'});

    // Create context rows HTML
    const before = this.renderCtxRows(data.ctx.before, 'before');
    const after = this.renderCtxRows(data.ctx.after, 'after');

    // Append context rows to their respective places
    var editCtxRows = $("tr.edit-ctx");
    editCtxRows.first().after(before);
    editCtxRows.last().before(after);
  },

  /* Gets more context units */
  moreContext: function (amount=CTX_STEP) {
    const uId = this.units.getCurrent().id;

    return (
      this.loadContext(uId, amount)
          .then(
            (data) => this.handleContextSuccess(data),
            this.error
          )
    );
  },

  /* Shrinks context lines */
  lessContext: function () {

    var before = $(".ctx-row.before"),
        after = $(".ctx-row.after");

    // Make sure there are context rows before decreasing the gap and
    // removing any context rows
    if (before.length || after.length) {
      if (before.length === this.ctxGap) {
        before.slice(0, CTX_STEP).remove();
      }

      if (after.length === this.ctxGap) {
        after.slice(-CTX_STEP).remove();
      }

      this.ctxGap -= CTX_STEP;

      if (this.ctxGap >= 0) {
        if (this.ctxGap === 0) {
          this.replaceCtxControls(this.renderCtxControls({ hasData: false }));
        }

        $.cookie('ctxQty', this.ctxGap, {path: '/'});
      }
    }
  },

  /* Shows context rows */
  showContext: function () {
    const $before = $('.ctx-row.before');
    const $after = $('.ctx-row.after');

    if ($before.length || $after.length) {
      $before.show();
      $after.show();
      this.replaceCtxControls(this.renderCtxControls({ hasData: true }))
    } else if (this.ctxQty > 0) {
      // This is an initial request for context, reset `ctxGap`
      this.ctxGap = 0;
      this.moreContext(this.ctxQty)
          .then(() => {
            this.replaceCtxControls(this.renderCtxControls({ hasData: true }))
          });
    }
  },

  /* Hides context rows */
  hideContext: function () {
    const $before = $('.ctx-row.before');
    const $after = $('.ctx-row.after');

    $before.hide();
    $after.hide();

    this.replaceCtxControls(this.renderCtxControls({ hasData: false }));
  },


  /* Loads the search view */
  onSearch: function (searchText) {
    if (!PTL.editor.canNavigate()) {
      return false;
    }

    var newHash;

    if (searchText) {
      let queryString = this.buildSearchQuery();
      newHash = "search=" + queryString;
    } else {
      newHash = utils.updateHashPart("filter", "all", ["search", "sfields","soptions"]);
    }
    $.history.load(newHash);
  },


  /*
   * Comments
   */
  comment: function (e) {
    e.preventDefault();

    PTL.editor.updateCommentDefaultProperties();

    var url = $(this).attr('action'),
        reqData = $(this).serializeObject();

    $.ajax({
      url: url,
      type: 'POST',
      data: reqData,
      success: function (data) {
        $('.js-editor-comment').removeClass('selected');
        $("#editor-comment").fadeOut(200);

        if ($("#translator-comment").length) {
          $(data.comment).hide().prependTo("#translator-comment").delay(200)
                         .animate({height: 'show'}, 1000, 'easeOutQuad');
        } else {
          var commentHtml = '<div id="translator-comment">' + data.comment
                          + '</div>';
          $(commentHtml).prependTo("#extras-container").delay(200)
                        .hide().animate({height: 'show'}, 1000, 'easeOutQuad');
        }

        helpers.updateRelativeDates();
      },
      error: PTL.editor.error
    });

    return false;
  },

  /* Removes last comment */
  removeComment: function (e) {
    e.preventDefault();

    var url = $(this).data('url');

    $.ajax({
      url: url,
      type: 'DELETE',
      success: function () {
        $('.js-comment-first').fadeOut(200);
      },
      error: PTL.editor.error
    });
  },


  /*
   * Unit timeline
   */

  /* Get the timeline data */
  showTimeline: function () {
    const $results = $('#timeline-results');
    if ($results.length) {
      $results.slideDown(1000, 'easeOutQuad');
      return;
    }

    const $node = $('.translate-container');
    $node.spin();

    fetch({
      url: `/xhr/units/${this.units.getCurrent().id}/timeline/`,
    }).then(
      (data) => this.renderTimeline(data),
      this.error
    ).always(() => $node.spin(false));
  },

  renderTimeline: function (data) {
    const uid = data.uid;

    if (data.timeline && uid === PTL.editor.units.getCurrent().id) {
      if ($("#translator-comment").length) {
        $(data.timeline).hide().insertAfter("#translator-comment")
                        .slideDown(1000, 'easeOutQuad');
      } else {
        $(data.timeline).hide().prependTo("#extras-container")
                        .slideDown(1000, 'easeOutQuad');
      }

      helpers.updateRelativeDates();

      $('.timeline-field-body').filter(':not([dir])').bidi();
      $("#js-show-timeline").addClass('selected');
    }
  },

  /* Hide the timeline panel */
  toggleTimeline: function (e) {
    e.preventDefault();
    const $timelineToggle = $('#js-toggle-timeline');
    $timelineToggle.toggleClass('selected');
    if ($timelineToggle.hasClass('selected')) {
      PTL.editor.showTimeline();
    } else {
      $("#timeline-results").slideUp(1000, 'easeOutQuad');
    }
  },


  /*
   * User and TM suggestions
   */

  /* Filters TM results and does some processing */
  filterTMResults: function (results, sourceText) {
    // FIXME: this just retrieves the first three results
    // we could limit based on a threshold too.
    var filtered = [];

    if (results.length > 0 && results[0].source === sourceText) {
      var $element = $(PTL.editor.focused);
      // set only if the textarea is empty
      if ($element.val() === '') {
        var text = results[0].target;
        $element.val(text).trigger('input');
        $element.caret(text.length, text.length);
        PTL.editor.goFuzzy();
      }
    }

    for (var i=0; i<results.length && i<3; i++) {
      if (results[i].username === 'nobody') {
        results[i].fullname = gettext('some anonymous user');
      } else if (!results[i].fullname) {
        results[i].fullname = gettext('someone');
      }
      results[i].fullname = _.escape(results[i].fullname);

      filtered.push(results[i]);
    }

    return filtered;
  },

  /* TM suggestions */
  getTMUnitsContent: function (data) {
    var unit = this.units.getCurrent(),
        store = unit.get('store'),
        src = store.get('source_lang'),
        tgt = store.get('target_lang'),
        sourceText = unit.get('source')[0],
        filtered = this.filterTMResults(data, sourceText),
        name = gettext("Similar translations");

    if (filtered.length) {
      return this.tmpl.tm({
        store: store.toJSON(),
        unit: unit.toJSON(),
        suggs: filtered,
        name: name,
      });
    }

    return '';
  },

  /* Gets TM suggestions from amaGama */
  getTMUnits: function () {
    var unit = this.units.getCurrent(),
        store = unit.get('store'),
        src = store.get('source_lang'),
        tgt = store.get('target_lang'),
        sText = unit.get('source')[0],
        pStyle = store.get('project_style'),
        tmUrl = this.settings.tmUrl + src + "/" + tgt +
          "/unit/?source=" + encodeURIComponent(sText) + "&jsoncallback=?";

    if (!sText.length) {
        return;
    }

    if (pStyle.length && pStyle != "standard") {
        tmUrl += '&style=' + pStyle;
    }

    // Always abort previous requests so we only get results for the
    // current unit
    if (this.tmReq !== null) {
      this.tmReq.abort();
    }

    this.tmReq = $.jsonp({
      url: tmUrl,
      callback: '_jsonp' + unit.id,
      dataType: 'jsonp',
      cache: true,
      success: function (data) {
        var uid = this.callback.slice(6);

        if (uid === unit.id && data.length) {
          var sourceText = unit.get('source')[0],
              filtered = PTL.editor.filterTMResults(data, sourceText),
              name = gettext("Similar translations"),
              tm = PTL.editor.tmpl.tm({store: store.toJSON(),
                                       unit: unit.toJSON(),
                                       suggs: filtered,
                                       name: name});

          $(tm).hide().appendTo("#extras-container")
                      .slideDown(1000, 'easeOutQuad');
        }
      },
      error: PTL.editor.error
    });
  },


  /* Rejects a suggestion */
  rejectSuggestion: function (e) {
    e.stopPropagation(); //we don't want to trigger a click on the text below
    var suggId = $(this).data("sugg-id"),
        element = $("#suggestion-" + suggId),
        unit = PTL.editor.units.getCurrent();

    const url = l(`/xhr/units/${unit.id}/suggestions/${suggId}/`);

    $.ajax({
      url: url,
      type: 'DELETE',
      success: (data) => {
        if (data.user_score) {
          score.set(data.user_score);
        }

        element.fadeOut(200, function () {
          $(this).remove();

          // Go to the next unit if there are no more suggestions left
          if (!$('.js-user-suggestion').length) {
            PTL.editor.gotoNext();
          }
        });
        $('.js-comment-first').fadeOut(200);
      },
      error: PTL.editor.error,
    });
  },


  /* Accepts a suggestion */
  acceptSuggestion: function (e, skipToNext) {
    e.stopPropagation(); //we don't want to trigger a click on the text below
    var suggId = $(this).data("sugg-id"),
        element = $("#suggestion-" + suggId),
        unit = PTL.editor.units.getCurrent(),
        skipToNext = skipToNext || false,
        translations;

    const url = l(`/xhr/units/${unit.id}/suggestions/${suggId}/`);

    $.ajax({
      url: url,
      type: 'POST',
      success: (data) => {
        // Update target textareas
        $.each(data.newtargets, function (i, target) {
          $("#id_target_f_" + i).val(target).focus();
        });

        // Update remaining suggestion's diff
        $.each(data.newdiffs, function (suggId, sugg) {
          $.each(sugg, function (i, target) {
             $("#suggdiff-" + suggId + "-" + i).html(target);
          });
        });

        // FIXME: handle this via events
        translations = $('.js-translation-area').map(function (i, el) {
          return $(el).val();
        }).get();
        unit.setTranslation(translations);
        unit.set('isfuzzy', false);

        if (data.user_score) {
          score.set(data.user_score);
        }

        let hasCriticalChecks = !!data.checks;
        $('.translate-container').toggleClass('error', hasCriticalChecks);
        if (hasCriticalChecks) {
          _refreshChecksSnippet(data.checks);
        }

        element.fadeOut(200, function () {
          $(this).remove();

          // Go to the next unit if there are no more suggestions left,
          // providing there are no critical failing checks
          if (!hasCriticalChecks &&
              (skipToNext || !$('.js-user-suggestion').length)) {
            PTL.editor.gotoNext();
          }
        });
      },
      error: PTL.editor.error,
    });

  },

  /* Mutes or unmutes a quality check marking it as false positive or not */
  toggleCheck: function () {
    var check = $(this).parent(),
        checkId = $(this).data("check-id"),
        uId = PTL.editor.units.getCurrent().id,
        url = l(['/xhr/units/', uId, '/checks/', checkId, '/toggle/'].join('')),
        falsePositive = !check.hasClass('false-positive'), // toggled value
        post = {},
        error;

    if (falsePositive) {
      post.mute = 1;
    }

    $.post(url, post,
      function (data) {
        check.toggleClass('false-positive', falsePositive);

        error = $('#translate-checks-block .check')
                  .not('.false-positive').size() > 0;

        $('.translate-container').toggleClass('error', error);
      }, "json");
  },

  /*
   * Machine Translation
   */

  /* Checks whether the provided source is supported */
  isSupportedSource: function (pairs, source) {
    for (var i in pairs) {
      if (source === pairs[i].source) {
        return true;
      }
    }
    return false;
  },


  /* Checks whether the provided target is supported */
  isSupportedTarget: function (pairs, target) {
    for (var i in pairs) {
      if (target === pairs[i].target) {
        return true;
      }
    }
    return false;
  },


  /* Adds a new MT service button in the editor toolbar */
  addMTButton: function (container, aClass, tooltip) {
      var btn = '<a class="translate-mt ' + aClass + '">';
      btn += '<i class="icon-' + aClass+ '" title="' + tooltip + '"><i/></a>';
      $(container).first().prepend(btn);
  },

  /* Goes through all source languages and adds a new MT service button
   * in the editor toolbar if the language is supported
   */
  addMTButtons: function (provider) {
    if (this.isSupportedTarget(provider.pairs, PTL.editor.settings.targetLang)) {
      var that = this,
          $sources = $(".translate-toolbar");

      $sources.each(function () {
        var source = normalizeCode(
          $(this).parents('.source-language').find('.translation-text').attr('lang')
        );

        if (that.isSupportedSource(provider.pairs, source)) {
          that.addMTButton($(this).find('.js-toolbar-buttons'),
            provider.buttonClassName,
            provider.hint + ' (' + source.toUpperCase() + '&rarr;' + PTL.editor.settings.targetLang.toUpperCase() + ')');
        }
      });
    }
  },

  collectArguments: function (s) {
    this.argSubs[this.argPos] = s;
    return "[" + (this.argPos++) + "]";
  },

  translate: function (linkObject, providerCallback) {
    var that = this,
        $areas = $('.js-translation-area'),
        $sources = $(linkObject).parents('.source-language').find('.translation-text'),
        langFrom = normalizeCode($sources[0].lang),
        langTo = normalizeCode($areas[0].lang);

    var htmlPat = /<[\/]?\w+.*?>/g,
    // The printf regex based on http://phpjs.org/functions/sprintf:522
        cPrintfPat = /%%|%(\d+\$)?([-+\'#0 ]*)(\*\d+\$|\*|\d+)?(\.(\*\d+\$|\*|\d+))?([scboxXuidfegEG])/g,
        csharpStrPat = /{\d+(,\d+)?(:[a-zA-Z ]+)?}/g,
        percentNumberPat = /%\d+/g,
        pos = 0;

    $sources.each(function (j) {
      // Reset collected arguments array and counter
      that.argSubs = [];
      that.argPos = 0;

      // Walk through known patterns and replace them with [N] placeholders
      var sourceText = $(this).text()
                              .replace(htmlPat,
                                       that.collectArguments.bind(that))
                              .replace(cPrintfPat,
                                       that.collectArguments.bind(that))
                              .replace(csharpStrPat,
                                       that.collectArguments.bind(that))
                              .replace(percentNumberPat,
                                       that.collectArguments.bind(that));

      providerCallback(sourceText, langFrom, langTo, function (opts) {
        var translation = opts.translation,
            msg = opts.msg,
            area = $areas[j],
            $area = $areas.eq(j),
            i, value;

        if (translation === undefined && msg) {
          PTL.editor.displayError(msg);
          return;
        }

        // Fix whitespace which may have been added around [N] blocks
        for (i=0; i<that.argSubs.length; i++) {
          if (sourceText.match(new RegExp("\\[" + i + "\\][^\\s]"))) {
            translation = translation.replace(
              new RegExp("\\[" + i + "\\]\\s+"), "[" + i + "]"
            );
          }
          if (sourceText.match(new RegExp("[^\\s]\\[" + i + "\\]"))) {
            translation = translation.replace(
              new RegExp("\\s+\\[" + i + "\\]"), "[" + i + "]"
            );
          }
        }

        // Replace temporary [N] placeholders back to their real values
        for (i=0; i<that.argSubs.length; i++) {
          value = that.argSubs[i].replace(/\&/g, '&amp;')
                                 .replace(/\</g, '&lt;')
                                 .replace(/\>/g, '&gt;');
          translation = translation.replace("[" + i + "]", value);
        }

        $area.val($('<div />').html(translation).text());
        autosize.update(area);

        // Save a copy of the resulting text in the DOM for further
        // similarity comparisons
        if (opts.storeResult) {
          $area.attr('data-translation-aid-mt', translation);
        }
      });
    });

    $areas.eq(0).trigger('input').focus();

    PTL.editor.goFuzzy();
    return false;
  }

};
