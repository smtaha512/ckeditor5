/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/* globals AbortController, URL, XMLHttpRequest, window */

/**
 * @module ckbox/ckboximageedit/ckboximageeditcommand
 */

import { Command, type Editor } from 'ckeditor5/src/core';
import { createElement, global, retry } from 'ckeditor5/src/utils';
import CKBoxEditing from '../ckboxediting';

import { prepareImageAssetAttributes } from '../ckboxcommand';

import type {
	CKBoxRawAssetDefinition,
	CKBoxRawAssetDataDefinition
} from '../ckboxconfig';

import type { InsertImageCommand } from '@ckeditor/ckeditor5-image';
import { sendHttpRequest } from '../utils';

/**
 * The CKBox edit image command.
 *
 * Opens the CKBox dialog for editing the image.
 */
export default class CKBoxImageEditCommand extends Command {
	/**
	 * Flag indicating whether the command is active, i.e. dialog is open.
	 */
	declare public value: boolean;

	/**
	 * The abort controller for aborting asynchronous processes.
	 */
	public controller: AbortController;

	/**
	 * The DOM element that acts as a mounting point for the CKBox Edit Image dialog.
	 */
	private _wrapper: Element | null = null;

	/**
	 * Stores the value of `ckboxImageId` when image with this attribute is selected.
	 */
	private _ckboxImageId: string | null = null;

	/**
	 * @inheritDoc
	 */
	constructor( editor: Editor ) {
		super( editor );

		this.value = false;
		this.controller = new AbortController();

		this._prepareListeners();
	}

	/**
	 * @inheritDoc
	 */
	public override refresh(): void {
		const editor = this.editor;

		this.value = this._getValue();

		const selectedElement = editor.model.document.selection.getSelectedElement();
		const isImageElement = selectedElement && ( selectedElement.is( 'element', 'imageInline' ) ||
			selectedElement.is( 'element', 'imageBlock' ) );

		if ( isImageElement && ( selectedElement.hasAttribute( 'ckboxImageId' ) ) ) {
			this.isEnabled = true;
			this._ckboxImageId = selectedElement.getAttribute( 'ckboxImageId' ) as string;
		} else {
			this.isEnabled = false;
			this._ckboxImageId = null;
		}
	}

	/**
	 * Opens the CKBox Image Editor dialog for editing the image.
	 */
	public override execute(): void {
		this.fire<CKBoxImageEditorEvent<'open'>>( 'ckboxImageEditor:open' );
	}

	/**
	 * Indicates if the CKBox Image Editor dialog is already opened.
	 */
	private _getValue(): boolean {
		return this._wrapper !== null;
	}

	/**
	 * Creates the options object for the CKBox Image Editor dialog.
	 *
	 * @returns The object with properties:
	 * - tokenUrl The token endpoint URL.
	 * - onClose The callback function invoked after closing the CKBox dialog.
	 * - onSave The callback function invoked after saving the edited image.
	 */
	private _prepareOptions() {
		const editor = this.editor;
		const ckboxConfig = editor.config.get( 'ckbox' )!;

		return {
			imageEditing: {
				allowOverwrite: false
			},
			tokenUrl: ckboxConfig.tokenUrl,
			onClose: () => this.fire<CKBoxImageEditorEvent<'close'>>( 'ckboxImageEditor:close' ),
			onSave: ( asset: CKBoxRawAssetDefinition ) =>
				this.fire<CKBoxImageEditorEvent<'save'>>( 'ckboxImageEditor:save', asset )
		};
	}

	/**
	 * Initializes various event listeners for the `ckboxImageEditor:*` events,
	 * because all functionality of the `ckboxImageEditor` command is event-based.
	 */
	private _prepareListeners(): void {
		const editor = this.editor;

		// Refresh the command after firing the `ckboxImageEditor:*` event.
		this.on<CKBoxImageEditorEvent>( 'ckboxImageEditor', () => {
			this.refresh();
		}, { priority: 'low' } );

		this.on<CKBoxImageEditorEvent<'open'>>( 'ckboxImageEditor:open', () => {
			if ( !this.isEnabled || this._getValue() ) {
				return;
			}

			this.value = true;
			this._wrapper = createElement( document, 'div', { class: 'ck ckbox-wrapper' } );

			global.document.body.appendChild( this._wrapper );

			window.CKBox.mountImageEditor(
				this._wrapper,
				{
					assetId: this._ckboxImageId,
					...this._prepareOptions()
				}
			);
		} );

		this.on<CKBoxImageEditorEvent<'close'>>( 'ckboxImageEditor:close', () => {
			if ( !this._wrapper ) {
				return;
			}

			this._wrapper.remove();
			this._wrapper = null;

			editor.editing.view.focus();
		} );

		this.on<CKBoxImageEditorEvent<'save'>>( 'ckboxImageEditor:save', ( evt, asset ) => {
			this._waitForAssetProcessed( asset ).then( () => {
				this.fire<CKBoxImageEditorEvent<'processed'>>( 'ckboxImageEditor:processed', asset );
			} );
		} );

		this.on<CKBoxImageEditorEvent<'processed'>>( 'ckboxImageEditor:processed', ( evt, asset ) => {
			const imageCommand: InsertImageCommand = editor.commands.get( 'insertImage' )!;

			const {
				imageFallbackUrl,
				imageSources,
				imageTextAlternative,
				imageWidth,
				imageHeight,
				imagePlaceholder
			} = prepareImageAssetAttributes( asset );

			editor.model.change( writer => {
				imageCommand.execute( {
					source: {
						src: imageFallbackUrl,
						sources: imageSources,
						alt: imageTextAlternative,
						width: imageWidth,
						height: imageHeight,
						...( imagePlaceholder ? { placeholder: imagePlaceholder } : null )
					}
				} );

				const selectedImageElement = editor.model.document.selection.getSelectedElement()!;

				writer.setAttribute( 'ckboxImageId', asset.data.id, selectedImageElement );
			} );
		} );
	}

	/**
	 * Get asset's status on server. If server respond with "success" status then
	 * image is already proceeded and ready for saving.
	 *
	 * @param data Data about certain asset.
	 */
	private async _getAssetStatusFromServer( data: CKBoxRawAssetDataDefinition ): Promise<CKBoxRawAssetDataDefinition> {
		const url = new URL( 'assets/' + data.id, this.editor.config.get( 'ckbox.serviceOrigin' )! );
		const abortController = new AbortController();
		const ckboxEditing = this.editor.plugins.get( CKBoxEditing );

		const response = await sendHttpRequest( {
			url,
			signal: abortController.signal,
			authorization: ckboxEditing.getToken().value
		} );
		const status = response.metadata.metadataProcessingStatus;

		if ( !status || status == 'queued' ) {
			throw new Error( 'Image has not been processed yet.' );
		}

		return response;
	}

	/**
	 * Waiting until asset is being processed.
	 *
	 * @param asset Data about certain asset.
	 */
	private async _waitForAssetProcessed( asset: CKBoxRawAssetDefinition ): Promise<CKBoxRawAssetDataDefinition | undefined> {
		try {
			return await retry( () => this._getAssetStatusFromServer( asset.data ) );
		} catch ( err ) {
			// TODO: Handle error;
		}
	}
}

/**
 * Fired when the command is executed, the dialog is closed or the asset is saved.
 *
 * @eventName ~CKBoxImageEditCommand#ckboxImageEditor
 */
type CKBoxImageEditorEvent<Name extends '' | 'save' | 'processed' | 'open' | 'close' = ''> = {
	name: Name extends '' ? 'ckboxImageEditor' : `ckboxImageEditor:${ Name }`;
	args: Name extends 'save' | 'processed' ? [ asset: CKBoxRawAssetDefinition ] : [];
};
